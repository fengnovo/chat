import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  artifactObjectKey,
  ArtifactVerificationError,
  projectSnapshotObjectKey,
} from '@repo/artifacts';
import {
  approvalDecisionSchema,
  createProjectSchema,
  createArtifactUploadSchema,
  createRunSchema,
  createSessionSchema,
  questionAnswerSchema,
  runCancellationChannel,
  runEventsChannel,
  updateSessionSchema,
  uploadProjectSchema,
  knowledgeBaseIdsSchema,
  type RunImageAttachment,
} from '@repo/contracts';
import { RepositoryNotFoundError } from '@repo/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { streamWorkflowRun } from './chat-stream.js';
import { streamAgentEvents } from './sse.js';
import type { ApiServices } from './types.js';

function idempotencyKey(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  const trimmed = resolved?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

const MAX_CHAT_ATTACHMENTS = 5;
const MAX_TEXT_ATTACHMENT_BYTES = 200_000;
const IMAGE_ATTACHMENT_RE = /^data:image\/(jpeg|png|gif|webp);base64,[a-z0-9+/=\r\n]+$/i;

class AttachmentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * 从用户消息的 file parts 中拆出：
 * - 图片附件（image/* data URL）→ 交给视觉模型做多模态输入；
 * - 文本附件（text/* data URL，≤200KB）→ 解码后以内联文本拼进消息正文。
 * 其他类型直接拒绝，避免把模型读不了的二进制静默吞掉。
 */
function extractChatAttachments(
  parts: unknown[],
  text: string,
): { message: string; images: RunImageAttachment[] } {
  const fileParts = parts.filter(
    (part): part is Record<string, unknown> =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'file',
  );
  if (fileParts.length > MAX_CHAT_ATTACHMENTS) {
    throw new AttachmentError('too_many_attachments');
  }

  const images: RunImageAttachment[] = [];
  let appendedText = '';
  for (const part of fileParts) {
    const mediaType = String(part.mediaType ?? '');
    const filename =
      typeof part.filename === 'string' && part.filename.trim()
        ? part.filename.trim().slice(0, 255)
        : undefined;
    const url = String(part.url ?? '');

    if (mediaType.startsWith('image/')) {
      if (!IMAGE_ATTACHMENT_RE.test(url) || url.length > 14_000_000) {
        throw new AttachmentError('invalid_image_attachment');
      }
      images.push({
        kind: 'image',
        mediaType: `image/${mediaType.slice(6).toLowerCase()}` as RunImageAttachment['mediaType'],
        ...(filename ? { filename } : {}),
        dataUrl: url,
      });
      continue;
    }

    if (mediaType.startsWith('text/')) {
      const comma = url.indexOf(',');
      const meta = comma >= 0 ? url.slice(0, comma) : '';
      const payload = comma >= 0 ? url.slice(comma + 1) : '';
      let decoded: string;
      try {
        decoded = meta.includes(';base64')
          ? Buffer.from(payload, 'base64').toString('utf8')
          : decodeURIComponent(payload);
      } catch {
        throw new AttachmentError('invalid_text_attachment');
      }
      if (Buffer.byteLength(decoded, 'utf8') > MAX_TEXT_ATTACHMENT_BYTES) {
        throw new AttachmentError('attachment_too_large');
      }
      appendedText += `\n\n[附件 ${filename ?? '文本文件'}]\n${decoded}`;
      continue;
    }

    throw new AttachmentError('unsupported_attachment_type');
  }

  const merged = `${text}${appendedText}`.trim();
  return {
    message: merged || (images.length > 0 ? '（用户发送了图片，请结合图片内容回答）' : ''),
    images,
  };
}

const sessionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1_000).optional(),
});

const sessionCursorSchema = z.object({
  updatedAt: z.string().datetime(),
  id: z.uuid(),
});

function encodeSessionCursor(cursor: { updatedAt: string; id: string }) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeSessionCursor(value?: string) {
  if (!value) return undefined;
  try {
    return sessionCursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['cursor'],
        message: 'Invalid session cursor',
      },
    ]);
  }
}

function projectUploadBytes(files: Array<{ contentBase64: string }>) {
  return files.reduce(
    (total, file) => total + Buffer.byteLength(file.contentBase64, 'base64'),
    0,
  );
}

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicHealthFailure(component: string) {
  return { status: 'not_ready', component, error: 'dependency_unavailable' } as const;
}

/**
 * 删除会话时级联清理它独占的沙箱文件目录。
 * docker 模式下文件在宿主 SANDBOX_SESSIONS_ROOT/<workspaceId>；
 * e2b-cloud 模式文件在云端沙箱内（随沙箱超时回收），API 侧无需处理。
 * 注意：workspaces.sandbox_provider 列在 docker 模式下不可靠（从不更新，
 * 保持 schema 默认值 'e2b'），因此这里只按本服务的运行时配置判断。
 * 清理失败只记录日志，不阻断会话删除（数据库记录已删，不应留下孤儿会话）。
 */
async function removeSessionWorkspace(
  services: ApiServices,
  workspace: { workspaceId: string } | null,
  log: { warn: (message: string) => void },
): Promise<void> {
  if (!workspace || services.config.SANDBOX_RUNTIME !== 'docker') return;
  if (!WORKSPACE_ID_PATTERN.test(workspace.workspaceId)) return;

  const root = path.resolve(services.config.SANDBOX_SESSIONS_ROOT);
  const target = path.resolve(root, workspace.workspaceId);
  const relative = path.relative(root, target);
  // 双保险：目标必须正好是根下的一层 UUID 目录，任何越界形态都不删。
  if (relative !== workspace.workspaceId || relative.startsWith('..')) return;

  await rm(target, { recursive: true, force: true }).catch((error: unknown) => {
    log.warn(
      `删除会话工作区目录失败 ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export async function registerRoutes(app: FastifyInstance, services: ApiServices) {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await services.repository.ping();
    } catch {
      return reply.code(503).send(publicHealthFailure('repository'));
    }
    try {
      await services.publisher.ping();
    } catch {
      return reply.code(503).send(publicHealthFailure('publisher'));
    }
    try {
      await services.artifacts.ping();
    } catch {
      return reply.code(503).send(publicHealthFailure('artifacts'));
    }
    return { status: 'ready' };
  });

  app.post('/api/agent/sessions', async (request, reply) => {
    const input = createSessionSchema.parse(request.body ?? {});
    const workspaceToken = randomUUID();
    const workspacePath = path.join(
      services.config.WORKSPACE_ROOT,
      request.auth.tenantId,
      workspaceToken,
    );
    try {
      const session = await services.repository.createSession(request.auth, {
        title: input.title,
        workspacePath,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.externalKey ? { externalKey: input.externalKey } : {}),
      });
      return reply.code(201).send(session);
    } catch (error) {
      if (error instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ error: `${error.resource}_not_found` });
      }
      throw error;
    }
  });

  app.get('/api/agent/sessions', async (request) => {
    const query = sessionListQuerySchema.parse(request.query ?? {});
    const cursor = decodeSessionCursor(query.cursor);
    const sessions = await services.repository.listSessions(request.auth, {
      limit: query.limit + 1,
      ...(cursor ? { cursor } : {}),
    });
    const hasMore = sessions.length > query.limit;
    const data = hasMore ? sessions.slice(0, query.limit) : sessions;
    const last = data.at(-1);
    return {
      data,
      nextCursor:
        hasMore && last
          ? encodeSessionCursor({ updatedAt: last.updatedAt, id: last.id })
          : null,
    };
  });

  app.get('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await services.repository.getSession(request.auth, sessionId);
    return session ?? reply.code(404).send({ error: 'session_not_found' });
  });

  app.patch('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = updateSessionSchema.parse(request.body);
    const session = await services.repository.renameSession(
      request.auth,
      sessionId,
      input.title,
    );
    return session ?? reply.code(404).send({ error: 'session_not_found' });
  });

  app.delete('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    // 删除前先取出工作区标识，用于级联清理该会话独占的文件目录。
    const workspace = await services.repository
      .getWorkspaceSandboxForWorker(request.auth.tenantId, sessionId)
      .catch(() => null);
    const result = await services.repository.deleteSession(request.auth, sessionId);
    if (result === 'not_found') {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    if (result === 'active') {
      return reply.code(409).send({ error: 'session_has_active_run' });
    }
    await removeSessionWorkspace(services, workspace, request.log);
    return reply.code(204).send();
  });

  app.get('/api/agent/projects', async (request) => ({
    data: await services.repository.listProjects(request.auth),
  }));

  app.post('/api/agent/projects', async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const project = await services.repository.createProject(request.auth, {
      name: input.name,
      sourceType: input.source.type,
      ...(input.source.type === 'git'
        ? {
            sourceRef: input.source.url,
            ...(input.source.ref ? { sourceRevision: input.source.ref } : {}),
          }
        : {}),
    });
    return reply.code(201).send(project);
  });

  app.post('/api/agent/projects/upload', async (request, reply) => {
    const input = uploadProjectSchema.parse(request.body);
    const sizeBytes = projectUploadBytes(input.files);
    if (sizeBytes > services.config.PROJECT_UPLOAD_MAX_BYTES) {
      return reply.code(413).send({ error: 'project_upload_too_large' });
    }
    const projectId = randomUUID();
    const objectKey = projectSnapshotObjectKey(request.auth.tenantId, projectId);
    const manifest = Buffer.from(
      JSON.stringify({ version: 1, files: input.files }),
      'utf8',
    );
    await services.artifacts.putObject(
      objectKey,
      manifest,
      'application/vnd.keen-agent.project+json',
    );
    const project = await services.repository.createProject(request.auth, {
      id: projectId,
      name: input.name,
      sourceType: 'upload',
      sourceRef: objectKey,
    });
    return reply.code(201).send(project);
  });

  app.get('/api/agent/sessions/:sessionId/history', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await services.repository.getSession(request.auth, sessionId);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const runs = await services.repository.listSessionRuns(request.auth, sessionId);
    const eventGroups = await Promise.all(
      runs.map((run) => services.repository.listEvents(request.auth, run.id, 0, 100_000)),
    );
    const messages = runs.flatMap((run, index) => {
      const assistantText = (eventGroups[index] ?? [])
        .filter((event) => event.type === 'assistant.delta')
        .map((event) => event.text)
        .join('');
      const citations = (eventGroups[index] ?? [])
        .filter((event) => event.type === 'retrieval.completed')
        .flatMap((event) => event.citations);
      return [
        {
          id: `user-${run.id}`,
          runId: run.id,
          role: 'user' as const,
          text: run.userMessage,
          createdAt: run.createdAt,
        },
        ...(assistantText
          ? [
              {
                id: `message-${run.id}`,
                runId: run.id,
                role: 'assistant' as const,
                text: assistantText,
                createdAt: run.updatedAt,
                ...(citations.length ? { citations } : {}),
              },
            ]
          : []),
      ];
    });

    return {
      session,
      messages,
      latestRun: runs.at(-1) ?? null,
    };
  });

  app.get('/api/agent/sessions/:sessionId/files', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await services.repository.getSession(request.auth, sessionId);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const runs = await services.repository.listSessionRuns(request.auth, sessionId);
    const eventGroups = await Promise.all(
      runs.map((run) => services.repository.listEvents(request.auth, run.id, 0, 100_000)),
    );

    const fileOps = new Map<string, { path: string; content: string | null; operation: string }>();
    for (const events of eventGroups) {
      for (const event of events) {
        if (event.type !== 'tool.started') continue;
        const tool = event.tool;
        if (
          tool !== 'write_file' &&
          tool !== 'edit_file' &&
          tool !== 'read_file' &&
          tool !== 'delete'
        ) {
          continue;
        }
        const args =
          event.input && typeof event.input === 'object'
            ? (event.input as Record<string, unknown>)
            : {};
        const filePath = String(args.file_path ?? args.path ?? '').trim();
        if (!filePath) continue;

        let content: string | null = fileOps.get(filePath)?.content ?? null;
        if (tool === 'write_file' || tool === 'edit_file') {
          const raw = args.content;
          if (typeof raw === 'string') content = raw;
        }
        fileOps.set(filePath, { path: filePath, content, operation: tool });
      }
    }

    return {
      files: [...fileOps.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
  });

  app.post('/api/agent/sessions/:sessionId/runs', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = createRunSchema.parse(request.body);
    const session = await services.repository.getSession(request.auth, sessionId);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    try {
      const key = idempotencyKey(request.headers['idempotency-key']);
      const result = await services.repository.createRun(request.auth, {
        sessionId,
        message: input.message,
        ...(key ? { idempotencyKey: key } : {}),
        knowledgeBaseIds: input.knowledgeBaseIds,
      });
      if (result.created) {
        services.outbox.wake();
      }
      return reply.code(result.created ? 202 : 200).send(result.run);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'session_has_active_run' });
      }
      if (error instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      throw error;
    }
  });

  app.get('/api/agent/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await services.repository.getRun(request.auth, runId);
    return run ?? reply.code(404).send({ error: 'run_not_found' });
  });

  app.get('/api/agent/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return streamAgentEvents(request, reply, services, runId);
  });

  app.post('/api/agent/runs/:runId/approvals/:interruptId', async (request, reply) => {
    const { runId, interruptId } = request.params as { runId: string; interruptId: string };
    const decision = approvalDecisionSchema.parse(request.body);
    const run = await services.repository.getRun(request.auth, runId);
    if (!run) return reply.code(404).send({ error: 'run_not_found' });
    if (run.status !== 'waiting_approval') {
      return reply.code(409).send({ error: 'run_not_waiting_for_approval' });
    }
    const interrupt = await services.repository.resolveInterrupt(
      request.auth,
      runId,
      interruptId,
      'approval',
      decision,
    );
    if (!interrupt) return reply.code(409).send({ error: 'interrupt_already_resolved' });
    services.outbox.wake();
    return reply.code(202).send({ status: 'queued' });
  });

  app.post('/api/agent/runs/:runId/questions/:interruptId', async (request, reply) => {
    const { runId, interruptId } = request.params as { runId: string; interruptId: string };
    const answer = questionAnswerSchema.parse(request.body);
    const run = await services.repository.getRun(request.auth, runId);
    if (!run) return reply.code(404).send({ error: 'run_not_found' });
    if (run.status !== 'waiting_question') {
      return reply.code(409).send({ error: 'run_not_waiting_for_question' });
    }
    const interrupt = await services.repository.resolveInterrupt(
      request.auth,
      runId,
      interruptId,
      'question',
      answer,
    );
    if (!interrupt) return reply.code(409).send({ error: 'interrupt_already_resolved' });
    services.outbox.wake();
    return reply.code(202).send({ status: 'queued' });
  });

  app.post('/api/agent/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const cancellation = await services.repository.requestCancellation(request.auth, runId);
    if (!cancellation) return reply.code(404).send({ error: 'active_run_not_found' });
    await services.publisher.publish(runCancellationChannel(runId), 'cancel');
    if (cancellation.event) {
      await services.publisher.publish(
        runEventsChannel(runId),
        String(cancellation.event.seq),
      );
    }
    return reply.code(202).send({
      status: cancellation.run.status === 'cancelled' ? 'cancelled' : 'cancelling',
    });
  });

  app.post('/api/agent/runs/:runId/artifacts', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const input = createArtifactUploadSchema.parse(request.body);
    if (input.sizeBytes > services.config.ARTIFACT_MAX_BYTES) {
      return reply.code(413).send({ error: 'artifact_too_large' });
    }
    const run = await services.repository.getRun(request.auth, runId);
    if (!run) return reply.code(404).send({ error: 'run_not_found' });

    const artifactId = randomUUID();
    const objectKey = artifactObjectKey(
      request.auth.tenantId,
      runId,
      artifactId,
      input.name,
    );
    const artifact = await services.repository.createArtifact(request.auth, {
      id: artifactId,
      runId,
      name: input.name,
      objectKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256.toLowerCase(),
    });
    const upload = await services.artifacts.createUpload(
      objectKey,
      input.contentType,
      input.sha256.toLowerCase(),
    );
    return reply.code(201).send({ artifact, ...upload });
  });

  app.post('/api/agent/artifacts/:artifactId/complete', async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const artifact = await services.repository.getArtifact(request.auth, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'artifact_not_found' });
    if (artifact.status === 'ready') return { artifact };
    try {
      await services.artifacts.verifyObject(artifact.objectKey, {
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      });
    } catch (error) {
      if (error instanceof ArtifactVerificationError) {
        return reply.code(409).send({
          error: 'artifact_verification_failed',
          message: error.message,
        });
      }
      throw error;
    }
    const ready = await services.repository.markArtifactReady(
      request.auth,
      artifactId,
    );
    const event = await services.repository.appendEvent(request.auth.tenantId, {
      runId: artifact.runId,
      timestamp: new Date().toISOString(),
      type: 'artifact.created',
      artifactId,
      name: artifact.name,
      contentType: artifact.contentType,
    });
    await services.publisher.publish(
      runEventsChannel(artifact.runId),
      String(event.seq),
    );
    return { artifact: ready };
  });

  app.get('/api/agent/artifacts/:artifactId', async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const artifact = await services.repository.getArtifact(request.auth, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'artifact_not_found' });
    if (artifact.status !== 'ready') {
      return reply.code(409).send({ error: 'artifact_not_ready' });
    }
    const expiresInSeconds = 300;
    return {
      artifact,
      downloadUrl: await services.artifacts.createDownloadUrl(
        artifact.objectKey,
        expiresInSeconds,
      ),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
    };
  });

  const chatRequestSchema = z.object({
    chat_id: z.string().min(1).max(200).optional(),
    project_id: z.uuid().optional(),
    knowledge_base_ids: knowledgeBaseIdsSchema.default([]),
    messages: z.array(z.record(z.string(), z.unknown())),
  });

  app.post('/api/chat', async (request, reply) => {
    const input = chatRequestSchema.parse(request.body);
    const lastUser = [...input.messages]
      .reverse()
      .find((message) => message.role === 'user');
    const parts = Array.isArray(lastUser?.parts) ? lastUser.parts : [];
    const text =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : parts
            .map((part) =>
              typeof part === 'object' && part !== null && 'text' in part
                ? String((part as { text: unknown }).text)
                : '',
            )
            .join('');

    let attachments: RunImageAttachment[];
    let message: string;
    try {
      const extracted = extractChatAttachments(parts, text);
      attachments = extracted.images;
      message = extracted.message;
    } catch (error) {
      if (error instanceof AttachmentError) {
        return reply.code(400).send({ error: error.code });
      }
      throw error;
    }
    if (!message.trim()) return reply.code(400).send({ error: 'message_required' });

    const externalKey = input.chat_id ?? randomUUID();
    const workspaceToken = randomUUID();
    try {
      const session = await services.repository.getOrCreateExternalSession(
        request.auth,
        {
          externalKey,
          title: message.trim().split('\n')[0]?.slice(0, 120) || '新会话',
          workspacePath: path.join(
            services.config.WORKSPACE_ROOT,
            request.auth.tenantId,
            workspaceToken,
          ),
          ...(input.project_id ? { projectId: input.project_id } : {}),
        },
      );
      const result = await services.repository.createRun(request.auth, {
        sessionId: session.id,
        message: message.trim(),
        knowledgeBaseIds: input.knowledge_base_ids,
        attachments,
      });
      if (result.created) services.outbox.wake();
      return streamWorkflowRun(request, reply, services, result.run.id);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'session_has_active_run' });
      }
      if (error instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ error: `${error.resource}_not_found` });
      }
      throw error;
    }
  });

  app.get('/api/chat/:runId/stream', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return streamWorkflowRun(request, reply, services, runId);
  });
}
