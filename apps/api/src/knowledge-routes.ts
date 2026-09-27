import { randomUUID } from 'node:crypto';

import { context } from '@opentelemetry/api';
import { ArtifactVerificationError, assertImageMagic } from '@repo/artifacts';
import { extractObservabilityContext, injectObservabilityContext } from '@repo/observability';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { answerWithCitations, searchKnowledge } from './knowledge-assistant.js';
import type { ApiConfig } from './config.js';
import type { KnowledgeRepositoryApi } from './types.js';

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/i);

/**
 * 知识库资源（图）的最小字节数。低于这个值的「图片」必然不是真图（最常见的来源是
 * git-lfs pointer，固定 130~134 字节）。把这个值作为上传阶段的第一道闸门。
 * 真图 JPEG/PNG/GIF/WEBP 头 12 字节就够识别，所以这个下限远高于魔数校验需要的长度。
 */
const MIN_KNOWLEDGE_ASSET_BYTES = 1024;
const documentMime = z.enum([
  'text/markdown',
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const assetMime = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const mime = z.union([documentMime, assetMime]);
/** knowledge_bases 内子目录路径，长度上限 + 不允许开头斜杠、连续斜杠。 */
const directorySchema = z.string().trim().max(500).regex(/^[^/].*$/, { message: 'directory must not start with /' }).transform((value) => value.replace(/\/{2,}/g, '/').replace(/\/$/, ''));

// 与 chat 附件分片阈值保持一致（routes.ts）：MinIO/S3 最小分片 5MiB。
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
const MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const multipartPartSchema = z.object({
  number: z.number().int().min(1).max(10_000),
  etag: z.string().min(1).max(255),
});

/**
 * 预签名直发：storedSizeBytes 达到阈值走 S3 multipart（逐片预签名），否则整文件 PUT。
 * 文档与资源共用；onMultipart 负责把 uploadId 落到对应表。
 */
async function presignKnowledgeUpload(
  services: Services,
  reply: any,
  options: {
    objectKey: string;
    mime: string;
    storedSha256: string;
    storedSizeBytes: number;
    contentEncoding: 'gzip' | null;
    entityKey: 'document' | 'asset';
    entity: unknown;
    onMultipart: (uploadId: string) => Promise<void>;
  },
) {
  if (options.storedSizeBytes >= MULTIPART_THRESHOLD_BYTES) {
    const multipart = await services.artifacts.createMultipartUpload(
      options.objectKey,
      options.mime,
      options.storedSha256,
      { contentEncoding: options.contentEncoding },
    );
    await options.onMultipart(multipart.uploadId);
    const partCount = Math.ceil(options.storedSizeBytes / MULTIPART_PART_BYTES);
    const parts = await Promise.all(
      Array.from({ length: partCount }, (_, index) =>
        services.artifacts.presignPartUpload(options.objectKey, multipart.uploadId, index + 1),
      ),
    );
    return reply.code(201).send({
      mode: 'multipart',
      [options.entityKey]: options.entity,
      uploadId: multipart.uploadId,
      partSize: MULTIPART_PART_BYTES,
      parts,
    });
  }
  const upload = await services.artifacts.createUpload(options.objectKey, options.mime, options.storedSha256);
  return reply.code(201).send({ mode: 'single', [options.entityKey]: options.entity, upload });
}

/** confirm 成功后入队索引任务；注入 trace 上下文，失败 fail-open。 */
async function enqueueIndexJob(services: Services, result: { job?: { id?: string } | null }) {
  if (!result.job?.id) return;
  let jobPayload: unknown = result.job;
  try {
    const carrier = injectObservabilityContext(context.active(), `knowledge:${result.job.id}`);
    jobPayload = { ...(result.job as Record<string, unknown>), observability: carrier };
  } catch {
    jobPayload = result.job;
  }
  await services.knowledgeQueue.add('index', jobPayload, { jobId: result.job.id });
}

type RouteConfig = {
  KNOWLEDGE_DOCUMENT_MAX_BYTES: number;
  KNOWLEDGE_MCP?: ApiConfig['KNOWLEDGE_MCP'];
  KNOWLEDGE_QA_MODEL?: ApiConfig['KNOWLEDGE_QA_MODEL'];
  CAPTION_ENABLED?: boolean;
};

type Services = {
  repository: KnowledgeRepositoryApi;
  knowledgeQueue: { add: (name: string, data: unknown, options?: { jobId?: string }) => Promise<unknown> };
  captionQueue?: { add: (name: string, data: unknown, options?: { jobId?: string }) => Promise<unknown> };
  artifacts: any;
  config: RouteConfig;
};

function notFound(reply: any, error = 'not_found') {
  return reply.code(404).send({ error });
}

function serviceUnavailable(reply: any, error: string) {
  return reply.code(503).send({ error });
}

export async function registerKnowledgeRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/knowledge-bases', async (request) => ({
    data: await services.repository.listKnowledgeBases(request.auth),
  }));

  app.post('/api/knowledge-bases', async (request, reply) => {
    const input = z.object({
      name: z.string().trim().min(1).max(200),
      description: z.string().max(2_000).optional(),
      visibility: z.enum(['private', 'tenant']).default('private'),
    }).parse(request.body ?? {});
    const result = await services.repository.createKnowledgeBase(request.auth, input);
    return reply.code(201).send(result);
  });

  app.get('/api/knowledge-bases/:kbId', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const result = await services.repository.getKnowledgeBase(request.auth, kbId);
    return result ?? notFound(reply, 'knowledge_base_not_found');
  });

  app.delete('/api/knowledge-bases/:kbId', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const result = await services.repository.deleteKnowledgeBase(request.auth, kbId);
    if (!result) return notFound(reply, 'knowledge_base_not_found');
    return reply.code(204).send();
  });

  app.patch('/api/knowledge-bases/:kbId', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const input = z.object({
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(2_000).nullable().optional(),
      visibility: z.enum(['private', 'tenant']).optional(),
    }).parse(request.body ?? {});
    const result = await services.repository.updateKnowledgeBase(request.auth, kbId, input);
    return result ?? notFound(reply, 'knowledge_base_not_found');
  });

  app.get('/api/knowledge-bases/:kbId/documents', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const result = await services.repository.listKnowledgeDocuments(request.auth, kbId);
    return { data: result };
  });

  app.get('/api/knowledge-bases/:kbId/documents/:documentId', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    const result = await services.repository.getKnowledgeDocument(request.auth, id.parse(params.kbId), id.parse(params.documentId));
    return result ?? notFound(reply, 'document_not_found');
  });

  app.delete('/api/knowledge-bases/:kbId/documents/:documentId', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    const result = await services.repository.deleteKnowledgeDocument(request.auth, id.parse(params.kbId), id.parse(params.documentId));
    if (!result) return notFound(reply, 'document_not_found');
    return reply.code(204).send();
  });

  app.patch('/api/knowledge-bases/:kbId/documents/:documentId', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    const input = z.object({ name: z.string().trim().min(1).max(255) }).parse(request.body ?? {});
    const result = await services.repository.renameKnowledgeDocument(
      request.auth,
      id.parse(params.kbId),
      id.parse(params.documentId),
      input.name,
    );
    return result ?? notFound(reply, 'document_not_found');
  });

  app.get('/api/knowledge-bases/:kbId/documents/:documentId/chunks', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    const query = z.object({
      q: z.string().trim().max(500).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(request.query ?? {});
    const kbId = id.parse(params.kbId);
    const documentId = id.parse(params.documentId);
    const document = await services.repository.getKnowledgeDocument(request.auth, kbId, documentId);
    if (!document) return notFound(reply, 'document_not_found');
    const result = await services.repository.listDocumentChunks(request.auth, kbId, documentId, {
      search: query.q,
      limit: query.limit,
      offset: query.offset,
    });
    return { data: result.rows, total: result.total };
  });

  app.post('/api/knowledge-bases/:kbId/documents/uploads', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    if (!(await services.repository.canWriteKnowledgeBase(request.auth, kbId))) return notFound(reply, 'knowledge_base_not_found');
    const input = z.object({
      name: z.string().trim().min(1).max(255),
      mime,
      sizeBytes: z.number().int().positive(),
      sha256: hash,
      // 实际存储口径：客户端 gzip 压缩后与原始值不同；未压缩时省略即等于原始值。
      storedSha256: hash.optional(),
      storedSizeBytes: z.number().int().positive().optional(),
      contentEncoding: z.enum(['gzip']).optional(),
      kind: z.enum(['document', 'asset']).default('document'),
      directory: directorySchema.optional(),
      relPath: z.string().trim().min(1).max(500).optional(),
      documentId: z.uuid().optional(),
    }).parse(request.body ?? {});
    if (input.sizeBytes > services.config.KNOWLEDGE_DOCUMENT_MAX_BYTES) return reply.code(400).send({ error: 'knowledge_document_too_large' });
    const storedSha256 = input.storedSha256 ?? input.sha256;
    const storedSizeBytes = input.storedSizeBytes ?? input.sizeBytes;
    const contentEncoding = input.contentEncoding ?? null;

    if (input.kind === 'asset') {
      if (!assetMime.options.includes(input.mime as never)) return reply.code(400).send({ error: 'asset_mime_unsupported' });
      if (input.sizeBytes < MIN_KNOWLEDGE_ASSET_BYTES) return reply.code(400).send({ error: 'asset_too_small', minBytes: MIN_KNOWLEDGE_ASSET_BYTES });
      const relPath = input.relPath ?? input.name;
      const assetId = randomUUID();
      const objectKey = `tenants/${request.auth.tenantId}/knowledge/${kbId}/assets/${assetId}/${input.name}`;
      const created = await services.repository.createAssetUpload(request.auth, {
        kbId,
        assetId,
        relPath,
        name: input.name,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        storedSha256,
        storedSizeBytes,
        contentEncoding,
        objectKey,
      });
      if (!created) return notFound(reply, 'knowledge_base_not_found');
      // 秒传：同 kb 已存在相同内容且上次上传真正完成过（uploaded_at 非空）。
      if (created.id !== assetId && (created.uploaded_at ?? created.uploadedAt)) {
        return reply.code(201).send({ mode: 'instant', asset: created });
      }
      return presignKnowledgeUpload(services, reply, {
        objectKey: created.object_key ?? created.objectKey,
        mime: input.mime,
        storedSha256,
        storedSizeBytes,
        contentEncoding,
        entityKey: 'asset',
        entity: created,
        onMultipart: (uploadId) => services.repository.setKnowledgeAssetUploadId(request.auth.tenantId, created.id, uploadId),
      });
    }

    if (!documentMime.options.includes(input.mime as never)) return reply.code(400).send({ error: 'document_mime_unsupported' });
    const documentId = input.documentId ?? randomUUID();
    const created = await services.repository.createDocumentUpload(request.auth, {
      ...input,
      kbId,
      documentId,
      storedSha256,
      storedSizeBytes,
      contentEncoding,
      objectKey: `tenants/${request.auth.tenantId}/knowledge/${kbId}/${documentId}/${input.name}`,
    });
    if (!created) return notFound(reply, 'knowledge_base_not_found');
    const objectKey = created.object_key ?? created.objectKey;

    // 秒传：同 kb 内已索引过（或正在索引）相同内容 → 直接复用文档，零字节上传。
    if (created.id !== documentId && created.status !== 'pending') {
      const stored = {
        sizeBytes: Number(created.stored_size_bytes ?? created.size_bytes),
        sha256: String(created.stored_sha256 ?? created.content_hash),
      };
      if (created.status !== 'failed') {
        return reply.code(201).send({ mode: 'instant', document: created });
      }
      // 上次索引失败：对象仍在的话直接重新校验并入队重试，不再传输字节。
      const objectIntact = await services.artifacts.verifyObject(objectKey, stored).then(
        () => true,
        (error: unknown) => {
          if (error instanceof ArtifactVerificationError) return false;
          throw error;
        },
      );
      if (objectIntact) {
        const result = await services.repository.confirmDocumentUpload(request.auth, kbId, created.id, stored);
        if (result?.created !== false) await enqueueIndexJob(services, result);
        return reply.code(201).send({ mode: 'instant', document: result?.document ?? created });
      }
      // 对象已被清理：落入下方重新预签名上传。
    }

    return presignKnowledgeUpload(services, reply, {
      objectKey,
      mime: input.mime,
      storedSha256,
      storedSizeBytes,
      contentEncoding,
      entityKey: 'document',
      entity: created,
      onMultipart: (uploadId) => services.repository.setKnowledgeDocumentUploadId(request.auth.tenantId, created.id, uploadId),
    });
  });

  app.post('/api/knowledge-bases/:kbId/documents/:documentId/confirm', async (request, reply) => {
    const params = request.params as { kbId: string; documentId: string };
    if (!(await services.repository.canWriteKnowledgeBase(request.auth, id.parse(params.kbId)))) return notFound(reply, 'document_not_found');
    const input = z.object({
      sizeBytes: z.number().int().positive(),
      sha256: hash,
      parts: z.array(multipartPartSchema).optional(),
    }).parse(request.body ?? {});
    const document = await services.repository.getKnowledgeDocument(request.auth, id.parse(params.kbId), id.parse(params.documentId));
    if (!document) return notFound(reply, 'document_not_found');
    if (input.sizeBytes > services.config.KNOWLEDGE_DOCUMENT_MAX_BYTES) return reply.code(400).send({ error: 'knowledge_document_too_large' });
    const objectKey = document.object_key ?? document.objectKey;
    const uploadId = document.upload_id ?? document.uploadId;
    if (uploadId) {
      if (!input.parts?.length) return reply.code(400).send({ error: 'parts_required' });
      await services.artifacts.completeMultipartUpload(objectKey, uploadId, input.parts);
    }
    try { await services.artifacts.verifyObject(objectKey, input); } catch (error) {
      if (error instanceof ArtifactVerificationError) return reply.code(400).send({ error: 'document_verification_failed' });
      throw error;
    }
    const result = await services.repository.confirmDocumentUpload(request.auth, id.parse(params.kbId), id.parse(params.documentId), input);
    if (!result) return notFound(reply, 'document_not_found');
    if (result.created !== false) await enqueueIndexJob(services, result);
    return reply.send(result.document ?? result);
  });

  // ─── 知识库资源（图片等）────────────────────────────────────────────────

  app.post('/api/knowledge-bases/:kbId/assets/:assetId/confirm', async (request, reply) => {
    const params = request.params as { kbId: string; assetId: string };
    const input = z.object({
      sizeBytes: z.number().int().positive(),
      sha256: hash,
      metadata: z.record(z.string(), z.unknown()).optional(),
      parts: z.array(multipartPartSchema).optional(),
    }).parse(request.body ?? {});
    if (input.sizeBytes > services.config.KNOWLEDGE_DOCUMENT_MAX_BYTES) return reply.code(400).send({ error: 'asset_too_large' });
    const asset = await services.repository.getKnowledgeAsset(request.auth, id.parse(params.kbId), id.parse(params.assetId));
    if (!asset) return notFound(reply, 'asset_not_found');
    const assetUploadId = asset.upload_id ?? asset.uploadId;
    if (assetUploadId) {
      if (!input.parts?.length) return reply.code(400).send({ error: 'parts_required' });
      await services.artifacts.completeMultipartUpload(asset.object_key, assetUploadId, input.parts);
    }
    try { await services.artifacts.verifyObject(asset.object_key, input); } catch (error) {
      if (error instanceof ArtifactVerificationError) return reply.code(400).send({ error: 'asset_verification_failed' });
      throw error;
    }
    // 第二道闸门：按声明的 MIME 校验对象前 12 字节的魔数。即使 LFS 指针蒙混过了上限 + 大小，
    // 这里会用 `getObjectHead` 拿真头部比较 PNG/JPEG/GIF/WEBP 各自的字节签名，不匹配直接 400。
    try {
      const head = await services.artifacts.getObjectHead(asset.object_key, 16);
      assertImageMagic(head, asset.mime);
    } catch (error) {
      if (error instanceof ArtifactVerificationError) return reply.code(400).send({ error: 'asset_magic_check_failed', message: error.message });
      throw error;
    }
    const result = await services.repository.confirmAssetUpload(request.auth, id.parse(params.kbId), id.parse(params.assetId), input);
    if (!result) return notFound(reply, 'asset_not_found');
    // caption_enabled 才入队；否则资产 caption_status 保持 'pending'，可由运维在管理页手动触发。
    if (services.config.CAPTION_ENABLED && services.captionQueue && /^(image|photo)\//.test(result.asset?.mime ?? '')) {
      try {
        const enqueued = await services.repository.enqueueCaptionJob({
          tenantId: request.auth.tenantId,
          kbId: id.parse(params.kbId),
          assetId: id.parse(params.assetId),
        });
        if (enqueued) {
          // 透传 traceparent / tracestate 让 worker 用 link 关联上传调用。
          const observabilityPayload = (() => {
            try {
              const headerValue = (name: string): string | undefined => {
                const raw = request.headers[name as keyof typeof request.headers];
                return typeof raw === 'string' ? raw : undefined;
              };
              return extractObservabilityContext({
                ...(headerValue('traceparent') ? { traceparent: headerValue('traceparent')! } : {}),
                ...(headerValue('tracestate') ? { tracestate: headerValue('tracestate')! } : {}),
                requestId: request.id,
              });
            } catch { return {}; }
          })();
          await services.captionQueue.add(
            'caption-asset',
            { tenantId: request.auth.tenantId, jobId: enqueued.id, observability: observabilityPayload },
            { jobId: enqueued.id },
          );
        }
      } catch (error) {
        request.log?.error?.(error, 'failed to enqueue caption job');
      }
    }
    return reply.send(result.asset);
  });

  app.get('/api/knowledge-bases/:kbId/assets', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    const query = z.object({
      documentId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(request.query ?? {});
    const rows = await services.repository.listKnowledgeAssets(request.auth, kbId, query);
    return { data: rows };
  });

  app.delete('/api/knowledge-bases/:kbId/assets/:assetId', async (request, reply) => {
    const params = request.params as { kbId: string; assetId: string };
    const ok = await services.repository.deleteKnowledgeAsset(request.auth, id.parse(params.kbId), id.parse(params.assetId));
    if (!ok) return notFound(reply, 'asset_not_found');
    return reply.code(204).send();
  });

  /** 流式返回资源二进制。带鉴权 + 走 api 代理，避开预签名 URL 过期 + CORS 问题。 */
  app.get('/api/knowledge-bases/:kbId/assets/:assetId/content', async (request, reply) => {
    const params = request.params as { kbId: string; assetId: string };
    const asset = await services.repository.getKnowledgeAsset(request.auth, id.parse(params.kbId), id.parse(params.assetId));
    if (!asset) return notFound(reply, 'asset_not_found');
    try {
      const bytes = await services.artifacts.getObjectBytes(asset.object_key);
      reply.header('content-type', asset.mime);
      reply.header('cache-control', 'private, max-age=600');
      return reply.send(bytes);
    } catch {
      return reply.code(502).send({ error: 'asset_fetch_failed' });
    }
  });

  const retrievalInputSchema = z.object({
    query: z.string().trim().min(1).max(2_000),
    topK: z.coerce.number().int().min(1).max(50).optional(),
    minScore: z.coerce.number().min(-1).max(1).optional(),
  });

  async function runRetrieval(
    request: { auth: { tenantId: string; userId: string } },
    reply: any,
    kbId: string,
    body: unknown,
  ) {
    const mcp = services.config.KNOWLEDGE_MCP;
    if (!mcp) return serviceUnavailable(reply, 'knowledge_service_unavailable');
    const kb = await services.repository.getKnowledgeBase(request.auth as any, kbId);
    if (!kb) return notFound(reply, 'knowledge_base_not_found');
    const input = retrievalInputSchema.parse(body ?? {});
    let result;
    try {
      result = await searchKnowledge(
        mcp,
        { tenantId: request.auth.tenantId, userId: request.auth.userId, kbIds: [kbId] },
        { query: input.query, topK: input.topK },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // knowledge-service 连接失败或 MCP 调用异常时返回 502，带结构化 error body。
      return reply.code(502).send({ error: 'knowledge_retrieval_failed', message: message.slice(0, 200) });
    }
    const minScore = input.minScore ?? 0;
    const citations = result.citations.filter((citation) => citation.score >= minScore);
    return { ...result, citations };
  }

  app.post('/api/knowledge-bases/:kbId/retrieval', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    return runRetrieval(request, reply, kbId, request.body);
  });

  app.post('/api/knowledge-bases/:kbId/ask', async (request, reply) => {
    const kbId = id.parse((request.params as { kbId: string }).kbId);
    if (!services.config.KNOWLEDGE_QA_MODEL) return serviceUnavailable(reply, 'knowledge_qa_unavailable');
    const body = z.object({
      question: z.string().trim().min(1).max(2_000),
      topK: z.coerce.number().int().min(1).max(50).optional(),
      minScore: z.coerce.number().min(-1).max(1).optional(),
    }).parse(request.body ?? {});
    const retrieved = await runRetrieval(request, reply, kbId, {
      query: body.question,
      topK: body.topK,
      minScore: body.minScore,
    });
    // runRetrieval 在服务未配置/库不可见时已经写回错误响应。
    if (reply.sent) return reply;
    const answer = await answerWithCitations(services.config.KNOWLEDGE_QA_MODEL, {
      question: body.question,
      citations: (retrieved as { citations: any[] }).citations,
      kbId,
    });
    return reply.send({ answer, retrieval: retrieved });
  });
}
