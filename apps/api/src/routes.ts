import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  artifactObjectKey,
  ArtifactVerificationError,
} from '@repo/artifacts';
import {
  approvalDecisionSchema,
  createArtifactUploadSchema,
  createRunSchema,
  createSessionSchema,
  questionAnswerSchema,
  runCancellationChannel,
  runEventsChannel,
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

export async function registerRoutes(app: FastifyInstance, services: ApiServices) {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await services.repository.ping();
      await services.publisher.ping();
      await services.artifacts.ping();
      return { status: 'ready' };
    } catch (error) {
      return reply.code(503).send({ status: 'not_ready', error: String(error) });
    }
  });

  app.post('/api/agent/sessions', async (request, reply) => {
    const input = createSessionSchema.parse(request.body ?? {});
    const workspaceToken = randomUUID();
    const workspacePath = path.join(
      services.config.WORKSPACE_ROOT,
      request.auth.tenantId,
      workspaceToken,
    );
    const session = await services.repository.createSession(request.auth, {
      title: input.title,
      workspacePath,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    return reply.code(201).send(session);
  });

  app.get('/api/agent/sessions', async (request) => {
    return { data: await services.repository.listSessions(request.auth) };
  });

  app.get('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await services.repository.getSession(request.auth, sessionId);
    return session ?? reply.code(404).send({ error: 'session_not_found' });
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
    messages: z.array(z.record(z.string(), z.unknown())),
  });

  app.post('/api/chat', async (request, reply) => {
    const input = chatRequestSchema.parse(request.body);
    const lastUser = [...input.messages]
      .reverse()
      .find((message) => message.role === 'user');
    const parts = Array.isArray(lastUser?.parts) ? lastUser.parts : [];
    const message =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : parts
            .map((part) =>
              typeof part === 'object' && part !== null && 'text' in part
                ? String((part as { text: unknown }).text)
                : '',
            )
            .join('');
    if (!message.trim()) return reply.code(400).send({ error: 'message_required' });

    const externalKey = input.chat_id ?? randomUUID();
    const workspaceToken = randomUUID();
    const session = await services.repository.getOrCreateExternalSession(request.auth, {
      externalKey,
      title: message.trim().split('\n')[0]?.slice(0, 120) || '新会话',
      workspacePath: path.join(
        services.config.WORKSPACE_ROOT,
        request.auth.tenantId,
        workspaceToken,
      ),
    });
    try {
      const result = await services.repository.createRun(request.auth, {
        sessionId: session.id,
        message: message.trim(),
      });
      if (result.created) services.outbox.wake();
      return streamWorkflowRun(request, reply, services, result.run.id);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'session_has_active_run' });
      }
      throw error;
    }
  });

  app.get('/api/chat/:runId/stream', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return streamWorkflowRun(request, reply, services, runId);
  });
}
