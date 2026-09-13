import { randomUUID } from 'node:crypto';

import { ArtifactVerificationError } from '@repo/artifacts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ApiConfig } from './config.js';
import type { KnowledgeRepositoryApi } from './types.js';

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const mime = z.enum(['text/markdown', 'text/plain']);

type Services = {
  repository: KnowledgeRepositoryApi;
  knowledgeQueue: { add: (name: string, data: unknown, options?: { jobId?: string }) => Promise<unknown> };
  artifacts: any;
  config: ApiConfig | { KNOWLEDGE_DOCUMENT_MAX_BYTES: number };
};

function notFound(reply: any, error = 'not_found') {
  return reply.code(404).send({ error });
}

export async function registerKnowledgeRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/knowledge-bases', async (request) => ({
    data: (await services.repository.listKnowledgeBases?.(request.auth)) ?? [],
  }));

  app.post('/api/knowledge-bases', async (request, reply) => {
    const input = z.object({
      name: z.string().trim().min(1).max(200),
      description: z.string().max(2_000).optional(),
      visibility: z.enum(['private', 'tenant']).default('private'),
    }).parse(request.body ?? {});
    const result = await services.repository.createKnowledgeBase?.(request.auth, input);
    return reply.code(201).send(result);
  });

  app.get('/api/knowledge-bases/:kbId', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const result = await services.repository.getKnowledgeBase?.(request.auth, kbId);
    return result ?? notFound(reply, 'knowledge_base_not_found');
  });

  app.delete('/api/knowledge-bases/:kbId', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const result = await services.repository.deleteKnowledgeBase?.(request.auth, kbId);
    if (!result) return notFound(reply, 'knowledge_base_not_found');
    return reply.code(204).send();
  });

  app.get('/api/knowledge-bases/:kbId/documents', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const result = await services.repository.listKnowledgeDocuments?.(request.auth, kbId);
    if (result === undefined) return notFound(reply, 'knowledge_base_not_found');
    return { data: result };
  });

  app.get('/api/knowledge-bases/:kbId/documents/:documentId', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    const result = await services.repository.getKnowledgeDocument?.(request.auth, id.parse(params.kbId), id.parse(params.documentId));
    return result ?? notFound(reply, 'document_not_found');
  });

  app.delete('/api/knowledge-bases/:kbId/documents/:documentId', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    const result = await services.repository.deleteKnowledgeDocument?.(request.auth, id.parse(params.kbId), id.parse(params.documentId));
    if (!result) return notFound(reply, 'document_not_found');
    return reply.code(204).send();
  });

  app.post('/api/knowledge-bases/:kbId/documents/uploads', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const input = z.object({ name: z.string().trim().min(1).max(255), mime, sizeBytes: z.number().int().positive(), sha256: hash }).parse(request.body ?? {});
    if (input.sizeBytes > services.config.KNOWLEDGE_DOCUMENT_MAX_BYTES) return reply.code(400).send({ error: 'knowledge_document_too_large' });
    const documentId = randomUUID();
    const created = await services.repository.createDocumentUpload?.(request.auth, { ...input, kbId, documentId, objectKey: `tenants/${request.auth.tenantId}/knowledge/${kbId}/${documentId}/${input.name}` });
    if (!created) return notFound(reply, 'knowledge_base_not_found');
    const upload = await services.artifacts.createUpload(created.objectKey, input.mime, input.sha256);
    return reply.code(201).send({ document: created, upload });
  });

  app.post('/api/knowledge-bases/:kbId/documents/:documentId/confirm', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    const input = z.object({ sizeBytes: z.number().int().positive(), sha256: hash }).parse(request.body ?? {});
    const document = await services.repository.getKnowledgeDocument?.(request.auth, id.parse(params.kbId), id.parse(params.documentId));
    if (!document) return notFound(reply, 'document_not_found');
    if (input.sizeBytes > services.config.KNOWLEDGE_DOCUMENT_MAX_BYTES) return reply.code(400).send({ error: 'knowledge_document_too_large' });
    try { await services.artifacts.verifyObject(document.objectKey, input); } catch (error) {
      if (error instanceof ArtifactVerificationError) return reply.code(400).send({ error: 'document_verification_failed' });
      throw error;
    }
    const result = await services.repository.confirmDocumentUpload?.(request.auth, id.parse(params.kbId), id.parse(params.documentId), input);
    if (!result) return notFound(reply, 'document_not_found');
    if (result.created !== false && result.job?.id) await services.knowledgeQueue.add('index', { ...result.job }, { jobId: result.job.id });
    return reply.send(result.document ?? result);
  });
}
