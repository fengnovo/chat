import { randomUUID } from 'node:crypto';
import { readFile, stat, readdir } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  artifactObjectKey,
  ArtifactVerificationError,
  chatAttachmentObjectKey,
  projectSnapshotObjectKey,
} from '@repo/artifacts';
import {
  approvalDecisionSchema,
  createProjectSchema,
  createArtifactUploadSchema,
  createChatAttachmentSchema,
  createRunSchema,
  createSessionSchema,
  questionAnswerSchema,
  runCancellationChannel,
  runEventsChannel,
  updateSessionSchema,
  uploadProjectSchema,
  knowledgeBaseIdsSchema,
  type RunAttachmentKind,
  type RunAttachmentRef,
} from '@repo/contracts';
import { RepositoryNotFoundError } from '@repo/db';
import { isSensitiveMemory } from '@repo/memory-core';
import { redactTelemetryValue } from '@repo/observability';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { streamWorkflowRun } from './chat-stream.js';
import { startRunEnqueue } from './observability.js';
import { streamAgentEvents } from './sse.js';
import type { ApiServices } from './types.js';

function idempotencyKey(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  const trimmed = resolved?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

const MAX_CHAT_ATTACHMENTS = 5;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 200_000;
const MAX_FILE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
/** 浏览器对 .md/.csv 等常见文本扩展名常给空 MIME，按扩展名兜底识别为文本。 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'jsx', 'py', 'sh', 'sql', 'ini', 'conf', 'toml',
]);

class AttachmentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * 服务端独立判定附件处理类型与大小上限（不信任前端传入的 kind）：
 * image → 视觉模型；text → 内联正文；file → 投进沙箱工作区。
 */
function resolveAttachmentKind(
  filename: string,
  contentType: string,
  sizeBytes: number,
): RunAttachmentKind {
  if (ALLOWED_IMAGE_TYPES.has(contentType)) {
    if (sizeBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new AttachmentError('image_attachment_too_large');
    }
    return 'image';
  }
  const extension = filename.includes('.')
    ? filename.split('.').pop()!.toLowerCase()
    : '';
  if (contentType.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) {
    if (sizeBytes > MAX_TEXT_ATTACHMENT_BYTES) {
      throw new AttachmentError('text_attachment_too_large');
    }
    return 'text';
  }
  if (sizeBytes > MAX_FILE_ATTACHMENT_BYTES) {
    throw new AttachmentError('file_attachment_too_large');
  }
  return 'file';
}

/** 历史消息里的附件：前端用此相对 URL 经鉴权重定向取原始内容。 */
function attachmentContentUrl(attachmentId: string) {
  return `/api/agent/chat-attachments/${encodeURIComponent(attachmentId)}/content`;
}

function attachmentHistoryView(attachment: {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: RunAttachmentKind;
}) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    url: attachmentContentUrl(attachment.id),
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

const memoryListQuerySchema = z.object({
  assistantKey: z.string().trim().min(1).max(100).default('chat'),
  scope: z.enum(['global', 'project']).optional(),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).refine((value) => value.scope !== 'project' || Boolean(value.projectId), {
  message: 'projectId is required for project scope',
  path: ['projectId'],
});
export const memoryUpdateInputSchema = z.object({ content: z.string().trim().min(1).max(2_000) });

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
  const version = services.config?.API_VERSION ?? '0.1.0';
  const observabilityHealth = services.observability?.health ?? {
    enabled: false,
    exporter: 'disabled' as const,
  };
  app.get('/health/live', async () => ({
    status: 'ok',
    version,
    checks: { server: { status: 'ok' } },
    observability: observabilityHealth,
  }));
  app.get('/health/ready', async (request, reply) => {
    const dependencies = [
      ['repository', () => services.repository.ping()],
      ['publisher', () => services.publisher.ping()],
      ['artifacts', () => services.artifacts.ping()],
    ] as const;
    const results = await Promise.allSettled(
      dependencies.map(([, check]) => check()),
    );
    const checks: Record<string, { status: 'ok' | 'not_ready' }> = {};
    let failedComponent: string | undefined;
    results.forEach((result, index) => {
      const component = dependencies[index]![0];
      checks[component] = { status: result.status === 'fulfilled' ? 'ok' : 'not_ready' };
      if (result.status === 'rejected') {
        failedComponent ??= component;
        request.log.error(
          { component, error: redactTelemetryValue(result.reason) },
          'readiness dependency failed',
        );
      }
    });
    const summary = {
      version,
      checks,
      observability: observabilityHealth,
    };
    if (failedComponent) {
      return reply.code(503).send({
        status: 'not_ready',
        ...summary,
        component: failedComponent,
        error: 'dependency_unavailable',
      });
    }
    return { status: 'ready', ...summary };
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

  app.get('/api/agent/memories', async (request) => {
    const query = memoryListQuerySchema.parse(request.query ?? {});
    return {
      data: await services.repository.listMemories({
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        assistantKey: query.assistantKey,
        ...(query.scope ? { scope: query.scope === 'global' ? 'global' as const : `project:${query.projectId ?? ''}` } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        limit: query.limit,
      }),
    };
  });

  app.delete('/api/agent/memories/:memoryId', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const existing = await services.repository.getMemory(request.auth.tenantId, request.auth.userId, memoryId);
    await services.repository.deleteMemory(
      request.auth.tenantId,
      request.auth.userId,
      memoryId,
    );
    if (existing && services.memoryIndexQueue) await services.memoryIndexQueue.add('delete', { memoryId }, { jobId: `delete:${memoryId}:${Date.now()}` }).catch(() => undefined);
    return reply.code(204).send();
  });

  app.patch('/api/agent/memories/:memoryId', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const input = memoryUpdateInputSchema.parse(request.body);
    if (isSensitiveMemory(input.content)) {
      return reply.code(400).send({ error: 'sensitive_memory_rejected' });
    }
    const memory = await services.repository.updateMemory(
      request.auth.tenantId,
      request.auth.userId,
      memoryId,
      input.content,
    );
    if (memory && services.memoryIndexQueue) await services.memoryIndexQueue.add('upsert', { memory }, { jobId: `upsert:${memory.id}:${memory.updatedAt}` }).catch(() => undefined);
    return memory ? memory : reply.code(404).send({ error: 'memory_not_found' });
  });

  app.delete('/api/agent/memories', async (request, reply) => {
    const query = z.object({ assistantKey: z.string().trim().min(1).max(100).default('chat') })
      .parse(request.query ?? {});
    await services.repository.clearMemories(
      request.auth.tenantId,
      request.auth.userId,
      query.assistantKey,
    );
    return reply.code(204).send();
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
    const attachmentsByRun = await services.repository.listChatAttachmentsByRuns(
      request.auth,
      runs.map((run) => run.id),
    );
    const messages = runs.flatMap((run, index) => {
      const events = eventGroups[index] ?? [];
      const assistantText = events
        .filter((event) => event.type === 'assistant.delta')
        .map((event) => event.text)
        .join('');
      const reasoning = events
        .filter((event) => event.type === 'assistant.reasoning')
        .map((event) => event.text)
        .join('');
      const citations = events
        .filter((event) => event.type === 'retrieval.completed')
        .flatMap((event) => event.citations);
      const attachments = (attachmentsByRun.get(run.id) ?? []).map(attachmentHistoryView);
      return [
        // 续跑 run 的 user_message 是服务端合成的内部指令，不来自用户，
        // 不渲染成用户气泡；若续跑产出了正文，只追加 assistant 消息。
        ...(run.continuation
          ? []
          : [
              {
                id: `user-${run.id}`,
                runId: run.id,
                role: 'user' as const,
                text: run.userMessage,
                createdAt: run.createdAt,
                ...(attachments.length ? { attachments } : {}),
              },
            ]),
        ...(assistantText
          ? [
              {
                id: `message-${run.id}`,
                runId: run.id,
                role: 'assistant' as const,
                text: assistantText,
                createdAt: run.updatedAt,
                ...(reasoning ? { reasoning } : {}),
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
    const enqueue = services.observability
      ? startRunEnqueue(services.observability, { requestId: request.id, jobKind: 'start' })
      : null;
    try {
      const key = idempotencyKey(request.headers['idempotency-key']);
      const result = await services.repository.createRun(request.auth, {
        sessionId,
        message: input.message,
        ...(key ? { idempotencyKey: key } : {}),
        knowledgeBaseIds: input.knowledgeBaseIds,
        ...(enqueue ? { observabilityContext: enqueue.observabilityContext } : {}),
      });
      enqueue?.finish({ runId: result.run.id, outboxId: result.outboxId, created: result.created });
      if (result.created) {
        services.outbox.wake();
      }
      return reply.code(result.created ? 202 : 200).send(result.run);
    } catch (error) {
      enqueue?.finish({ created: false, error });
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
    const enqueue = services.observability
      ? startRunEnqueue(services.observability, { requestId: request.id, jobKind: 'resume-approval' })
      : null;
    let interrupt;
    try {
      interrupt = await services.repository.resolveInterrupt(
        request.auth,
        runId,
        interruptId,
        'approval',
        decision,
        enqueue?.observabilityContext,
      );
    } catch (error) {
      enqueue?.finish({ runId, created: false, error });
      throw error;
    }
    if (!interrupt) {
      enqueue?.finish({ runId, created: false });
      return reply.code(409).send({ error: 'interrupt_already_resolved' });
    }
    enqueue?.finish({ runId, created: true });
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
    const enqueue = services.observability
      ? startRunEnqueue(services.observability, { requestId: request.id, jobKind: 'resume-question' })
      : null;
    let interrupt;
    try {
      interrupt = await services.repository.resolveInterrupt(
        request.auth,
        runId,
        interruptId,
        'question',
        answer,
        enqueue?.observabilityContext,
      );
    } catch (error) {
      enqueue?.finish({ runId, created: false, error });
      throw error;
    }
    if (!interrupt) {
      enqueue?.finish({ runId, created: false });
      return reply.code(409).send({ error: 'interrupt_already_resolved' });
    }
    enqueue?.finish({ runId, created: true });
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

  // ── 聊天附件（选中即传，发送时只带 id 引用） ─────────────────────────

  app.post('/api/agent/chat-attachments', async (request, reply) => {
    const input = createChatAttachmentSchema.parse(request.body);
    const filename = input.filename.trim().slice(0, 255) || 'attachment';
    const contentType = input.contentType.trim().toLowerCase().slice(0, 200) || 'application/octet-stream';
    const sha256 = input.sha256.toLowerCase();

    let kind: RunAttachmentKind;
    try {
      kind = resolveAttachmentKind(filename, contentType, input.sizeBytes);
    } catch (error) {
      if (error instanceof AttachmentError) {
        return reply.code(413).send({ error: error.code });
      }
      throw error;
    }

    const attachmentId = randomUUID();
    const objectKey = chatAttachmentObjectKey(
      request.auth.tenantId,
      request.auth.userId,
      attachmentId,
      filename,
    );
    const attachment = await services.repository.createChatAttachment(request.auth, {
      id: attachmentId,
      objectKey,
      filename,
      contentType,
      sizeBytes: input.sizeBytes,
      sha256,
      kind,
    });
    const upload = await services.artifacts.createUpload(
      objectKey,
      contentType,
      sha256,
      300,
    );
    return reply.code(201).send({
      attachment: attachmentHistoryView(attachment),
      ...upload,
    });
  });

  app.post('/api/agent/chat-attachments/:id/complete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = await services.repository.getChatAttachment(request.auth, id);
    if (!attachment) return reply.code(404).send({ error: 'attachment_not_found' });
    if (attachment.status !== 'ready') {
      try {
        await services.artifacts.verifyObject(attachment.objectKey, {
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
        });
      } catch (error) {
        if (error instanceof ArtifactVerificationError) {
          return reply.code(409).send({
            error: 'attachment_verification_failed',
            message: error.message,
          });
        }
        throw error;
      }
      await services.repository.markChatAttachmentReady(request.auth, id);
    }
    return { attachment: attachmentHistoryView(attachment) };
  });

  app.delete('/api/agent/chat-attachments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = await services.repository.getChatAttachment(request.auth, id);
    if (!attachment) return reply.code(404).send({ error: 'attachment_not_found' });
    // 已关联 run 的附件属于聊天历史，不允许删除。
    if (attachment.runId) {
      return reply.code(409).send({ error: 'attachment_in_use' });
    }
    await services.artifacts.deleteObject(attachment.objectKey);
    await services.repository.deleteChatAttachment(id);
    return reply.code(204).send();
  });

  /** 附件内容统一入口：校验归属后 302 到新鲜的预签名下载地址，不向前端暴露长期 URL。 */
  app.get('/api/agent/chat-attachments/:id/content', async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = await services.repository.getChatAttachment(request.auth, id);
    if (!attachment) return reply.code(404).send({ error: 'attachment_not_found' });
    if (attachment.status !== 'ready') {
      return reply.code(409).send({ error: 'attachment_not_ready' });
    }
    const downloadUrl = await services.artifacts.createDownloadUrl(
      attachment.objectKey,
      120,
    );
    return reply.redirect(downloadUrl, 302);
  });

  const chatRequestSchema = z.object({
    chat_id: z.string().min(1).max(200).optional(),
    project_id: z.uuid().optional(),
    knowledge_base_ids: knowledgeBaseIdsSchema.default([]),
    messages: z.array(z.record(z.string(), z.unknown())),
    attachment_ids: z.array(z.uuid()).max(MAX_CHAT_ATTACHMENTS).default([]),
    continuation: z.boolean().optional(),
  });

  /**
   * 「继续对话」时发给模型的内部续跑指令。不是用户说的话：
   * 前端不显示气泡，历史接口也会跳过该 run 的用户消息。
   */
  const CONTINUATION_INSTRUCTION =
    '上一轮任务因执行错误中断了。请基于上方对话和已完成的工作，继续完成上一条用户消息所要求的任务；先检查当前进度，不要重复已经完成的步骤。';

  app.post('/api/chat', async (request, reply) => {
    const input = chatRequestSchema.parse(request.body);
    const continuation = input.continuation === true;
    if (continuation && !input.chat_id) {
      // 续跑必须依附于一个已存在的会话，不允许凭空创建。
      return reply.code(400).send({ error: 'continuation_requires_session' });
    }

    let attachmentRefs: RunAttachmentRef[] = [];
    let message: string;
    if (continuation) {
      // 续跑忽略客户端消息内容，统一使用服务端合成的内部指令，防止被伪造。
      message = CONTINUATION_INSTRUCTION;
    } else {
      const lastUser = [...input.messages]
        .reverse()
        .find((message) => message.role === 'user');
      const parts = Array.isArray(lastUser?.parts) ? lastUser.parts : [];
      message =
        typeof lastUser?.content === 'string'
          ? lastUser.content
          : parts
              .map((part) =>
                typeof part === 'object' && part !== null && 'text' in part
                  ? String((part as { text: unknown }).text)
                  : '',
              )
              .join('');

      // 附件按引用校验：必须是本人、已上传就绪、且尚未被其他 run 使用的。
      if (input.attachment_ids.length > 0) {
        const records = await services.repository.getReadyChatAttachments(
          request.auth,
          input.attachment_ids,
        );
        if (records.length !== new Set(input.attachment_ids).size) {
          return reply.code(400).send({ error: 'invalid_attachment' });
        }
        attachmentRefs = records.map((record) => ({
          id: record.id,
          kind: record.kind,
          objectKey: record.objectKey,
          filename: record.filename,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
        }));
      }

      if (!message.trim()) {
        if (attachmentRefs.length === 0) {
          return reply.code(400).send({ error: 'message_required' });
        }
        message = '（用户发送了附件，请结合附件内容完成任务）';
      }
    }

    const externalKey = input.chat_id ?? randomUUID();
    const workspaceToken = randomUUID();
    try {
      let session;
      if (continuation) {
        // 只查询，不隐式创建：会话不存在直接 404。
        const existing = await services.repository.getSessionByExternalKey(
          request.auth,
          externalKey,
        );
        if (!existing) return reply.code(404).send({ error: 'session_not_found' });
        session = existing;
      } else {
        session = await services.repository.getOrCreateExternalSession(
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
      }
      const enqueue = services.observability
        ? startRunEnqueue(services.observability, { requestId: request.id, jobKind: 'start' })
        : null;
      let result;
      try {
        result = await services.repository.createRun(request.auth, {
          sessionId: session.id,
          message: message.trim(),
          knowledgeBaseIds: input.knowledge_base_ids,
          attachments: attachmentRefs,
          continuation,
          ...(enqueue ? { observabilityContext: enqueue.observabilityContext } : {}),
        });
      } catch (error) {
        enqueue?.finish({ created: false, error });
        throw error;
      }
      enqueue?.finish({ runId: result.run.id, outboxId: result.outboxId, created: result.created });
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

  // ── 构建预览（静态文件服务 + 重新构建） ──────────────────────────────

  const SANDBOX_IMAGE = process.env.DOCKER_SANDBOX_IMAGE?.trim() || 'chat-agent-sandbox:latest';
  const DOCKER_WORKSPACE = '/mnt/user-data/workspace';

  /** 按 session → workspace_id 反推宿主侧沙箱工作区绝对路径。 */
  async function resolveSandboxWorkspacePath(tenantId: string, sessionId: string): Promise<string | null> {
    if (services.config.SANDBOX_RUNTIME !== 'docker') return null;
    const workspace = await services.repository
      .getWorkspaceSandboxForWorker(tenantId, sessionId)
      .catch(() => null);
    if (!workspace?.workspaceId) return null;
    return path.join(services.config.SANDBOX_SESSIONS_ROOT, workspace.workspaceId, 'user-data', 'workspace');
  }

  /** 仅通过 session ID 查找沙箱路径（用于公开预览路由，无需认证）。 */
  async function resolveSandboxWorkspacePathBySession(sessionId: string): Promise<string | null> {
    if (services.config.SANDBOX_RUNTIME !== 'docker') return null;
    
    // 通过 sessionId（external_key）查询对应的 workspace_id
    const workspaceId = await services.repository.getWorkspaceIdByExternalKey(sessionId);
    if (!workspaceId) return null;
    
    // 使用 workspace_id 作为沙箱目录名
    const sandboxPath = path.join(services.config.SANDBOX_SESSIONS_ROOT, workspaceId, 'user-data', 'workspace');
    try {
      const info = await stat(sandboxPath);
      if (info.isDirectory()) return sandboxPath;
    } catch {
      /* 目录不存在 */
    }
    return null;
  }

  /** 在宿主工作区内查找包含 index.html 的预览根目录。 */
  async function findPreviewRoot(workspacePath: string): Promise<string | null> {
    // 优先 workspace/dist/，其次 workspace 根目录本身
    const candidates = [
      path.join(workspacePath, 'dist'),
      workspacePath,
    ];
    for (const dir of candidates) {
      const indexFile = path.join(dir, 'index.html');
      try {
        const info = await stat(indexFile);
        if (info.isFile()) return dir;
      } catch { /* 不存在 */ }
    }
    // 扫描一级子目录（AI 可能写到子目录的 dist/ 下）
    try {
      const entries = await readdir(workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const distDir = path.join(workspacePath, entry.name, 'dist');
        try {
          const info = await stat(path.join(distDir, 'index.html'));
          if (info.isFile()) return distDir;
        } catch { /* 不存在 */ }
      }
    } catch { /* 工作区不存在 */ }
    return null;
  }

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
  };

  /** 提供会话沙箱内的构建产物预览（只读静态文件服务）。 */
  const servePreview = async (request: any, reply: any) => {
    const { sessionId } = request.params as { sessionId: string };
    const wildcard = (request.params as Record<string, string>)['*'] ?? '';
    const requestPath = wildcard || 'index.html';

    // 安全检查：验证请求来自本站（iframe 内嵌时浏览器会自动携带 Origin/Referer）
    const origin = request.headers.origin ?? request.headers.referer ?? '';
    const allowedOrigins = [
      services.config.WEB_ORIGIN,
      `http://localhost:${services.config.API_PORT}`,
      `http://127.0.0.1:${services.config.API_PORT}`,
    ];
    if (!allowedOrigins.some((o) => origin.startsWith(o))) {
      console.log('[preview] blocked_by_origin:', { origin, allowedOrigins });
      return reply.code(403).send({ error: 'forbidden' });
    }

    // 公开预览路由：不依赖认证，直接通过 session ID 查找沙箱
    const sandboxPath = await resolveSandboxWorkspacePathBySession(sessionId);
    if (!sandboxPath) {
      console.log('[preview] sandbox_not_found:', { sessionId });
      return reply.code(404).send({ error: 'sandbox_not_found' });
    }

    const previewRoot = await findPreviewRoot(sandboxPath);
    if (!previewRoot) {
      console.log('[preview] no_preview_built:', { sandboxPath });
      return reply.code(404).send({ error: 'no_preview_built' });
    }

    const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.resolve(previewRoot, safePath);
    console.log('[preview] serving:', { previewRoot, requestPath, filePath });
    // 路径遍历保护
    if (!filePath.startsWith(previewRoot)) return reply.code(403).send({ error: 'forbidden' });

    try {
      const info = await stat(filePath);
      if (!info.isFile()) return reply.code(404).send({ error: 'not_found' });
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      const content = await readFile(filePath);
      return reply.code(200).header('content-type', contentType).header('cache-control', 'no-cache').send(content);
    } catch (err) {
      console.log('[preview] read_error:', { filePath, err });
      return reply.code(404).send({ error: 'not_found' });
    }
  };
  app.get('/api/agent/sessions/:sessionId/preview', servePreview);
  app.get('/api/agent/sessions/:sessionId/preview/*', servePreview);

  /** 在沙箱容器内重新构建项目（vite build），产物输出到 workspace/dist/。 */
  app.post('/api/agent/sessions/:sessionId/rebuild', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    // sessionId 可能是 external_key（前端统一传 externalKey），需解析为内部 id
    const session = await services.repository.getSessionByExternalKey(request.auth, sessionId).catch(() => null);
    const resolvedSessionId = session?.id ?? sessionId;

    const sandboxPath = await resolveSandboxWorkspacePath(request.auth.tenantId, resolvedSessionId);
    if (!sandboxPath) return reply.code(404).send({ error: 'sandbox_not_found' });

    if (services.config.SANDBOX_RUNTIME !== 'docker') {
      return reply.code(400).send({ error: 'rebuild_requires_docker' });
    }

    const containerName = `rebuild-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;
    const buildScript = [
      'set -e',
      `cd ${DOCKER_WORKSPACE}`,
      // 查找包含 package.json 的项目目录
      'PROJECT_DIR="."',
      'if [ ! -f package.json ]; then',
      '  for d in */; do',
      '    if [ -f "${d}package.json" ]; then PROJECT_DIR="${d}"; break; fi',
      '  done',
      'fi',
      'cd "$PROJECT_DIR"',
      `npx vite build --base ./ --outDir ${DOCKER_WORKSPACE}/dist 2>&1`,
    ].join(' && ');

    const args = [
      'run', '--rm',
      '--name', containerName,
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '128',
      '--memory', '768m',
      '--cpus', '1.5',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--user', '65532:65532',
      '--env', 'HOME=/tmp',
      '--workdir', DOCKER_WORKSPACE,
      '--mount', `type=bind,src=${sandboxPath},dst=/mnt/user-data`,
      SANDBOX_IMAGE,
      '/bin/bash', '-lc', buildScript,
    ];

    const output = await new Promise<{ stdout: string; exitCode: number }>((resolveExec) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const maxBytes = 100_000;
      child.stdout.on('data', (chunk: Buffer) => {
        if (totalBytes < maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - totalBytes));
          totalBytes += chunk.length;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (totalBytes < maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - totalBytes));
          totalBytes += chunk.length;
        }
      });
      child.once('error', () => resolveExec({ stdout: 'Docker 执行出错', exitCode: 1 }));
      child.once('close', (code) => resolveExec({
        stdout: Buffer.concat(chunks).toString('utf8'),
        exitCode: code ?? 1,
      }));
    });

    if (output.exitCode === 0) {
      return { status: 'ok', previewUrl: `/api/agent/sessions/${sessionId}/preview/` };
    }
    return reply.code(500).send({ error: 'build_failed', output: output.stdout.slice(0, 5000) });
  });
}
