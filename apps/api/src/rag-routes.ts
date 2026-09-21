import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createRagQaService } from './rag-qa.js';
import type { ApiConfig } from './config.js';
import type { KnowledgeRepositoryApi } from './types.js';

interface RagRouteServices {
  config: ApiConfig;
  knowledgeRepository: KnowledgeRepositoryApi;
}

const id = z.uuid();

const ragStreamBodySchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  topK: z.coerce.number().int().min(1).max(50).optional(),
  minScore: z.coerce.number().min(-1).max(1).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(10_000),
      }),
    )
    .max(20)
    .optional(),
});

export async function registerRagRoutes(app: FastifyInstance, services: RagRouteServices) {
  const ragService = createRagQaService({ config: services.config });

  app.get('/api/rag/health', async () => ({
    available: ragService.isAvailable(),
  }));

  app.post('/api/knowledge-bases/:kbId/rag', async (request, reply) => {
    if (!ragService.isAvailable()) {
      return reply.code(503).send({ error: 'rag_qa_unavailable' });
    }

    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const kb = await services.knowledgeRepository.getKnowledgeBase(request.auth, kbId);
    if (!kb) return reply.code(404).send({ error: 'knowledge_base_not_found' });

    const body = ragStreamBodySchema.parse(request.body ?? {});
    const { answer, citations } = await ragService.answer({
      question: body.question,
      kbId,
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      topK: body.topK,
      minScore: body.minScore,
      history: body.history,
    });

    return {
      answer,
      citations,
      model: services.config.KNOWLEDGE_QA_MODEL?.model,
    };
  });

  app.post('/api/knowledge-bases/:kbId/rag-stream', async (request, reply) => {
    if (!ragService.isAvailable()) {
      return reply.code(503).send({ error: 'rag_qa_unavailable' });
    }

    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const kb = await services.knowledgeRepository.getKnowledgeBase(request.auth, kbId);
    if (!kb) return reply.code(404).send({ error: 'knowledge_base_not_found' });

    const body = ragStreamBodySchema.parse(request.body ?? {});

    const controller = new AbortController();
    request.raw.once('close', () => controller.abort());
    request.raw.once('aborted', () => controller.abort());

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'x-request-id': request.id,
    });
    reply.raw.flushHeaders();

    const stream = ragService.stream(
      {
        question: body.question,
        kbId,
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        topK: body.topK,
        minScore: body.minScore,
        history: body.history,
      },
      controller.signal,
    );

    const reader = stream.getReader();

    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        const ok = reply.raw.write(value);
        if (!ok) {
          await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
        }
      }
    } catch (error) {
      request.log.warn({ error }, 'rag stream error');
    } finally {
      reader.releaseLock();
      reply.raw.end();
    }
  });
}
