import type { S3ArtifactStore } from '@repo/artifacts';
import type { AuthContext } from '@repo/contracts';
import type { AgentRepository } from '@repo/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { ApiConfig } from './config.js';
import type { RunOutboxDispatcher } from './outbox.js';
import type { StreamSubscriptionHub } from './stream-subscriptions.js';
import type { ApiObservability } from './observability.js';

export interface KnowledgeRepositoryApi {
  listKnowledgeBases: (auth: AuthContext) => Promise<unknown[]>;
  getKnowledgeBase: (auth: AuthContext, id: string) => Promise<unknown | null>;
  canWriteKnowledgeBase: (auth: AuthContext, id: string) => Promise<boolean>;
  createKnowledgeBase: (auth: AuthContext, input: unknown) => Promise<unknown>;
  updateKnowledgeBase: (
    auth: AuthContext,
    id: string,
    input: { name?: string | undefined; description?: string | null | undefined; visibility?: 'private' | 'tenant' | undefined },
  ) => Promise<unknown | null>;
  deleteKnowledgeBase: (auth: AuthContext, id: string) => Promise<boolean | 'not_found'>;
  listKnowledgeDocuments: (auth: AuthContext, kbId: string) => Promise<unknown[]>;
  getKnowledgeDocument: (auth: AuthContext, kbId: string, id: string) => Promise<any | null>;
  createDocumentUpload: (auth: AuthContext, input: unknown) => Promise<any>;
  confirmDocumentUpload: (auth: AuthContext, kbId: string, id: string, input: unknown) => Promise<any>;
  renameKnowledgeDocument: (auth: AuthContext, kbId: string, id: string, name: string) => Promise<any | null>;
  deleteKnowledgeDocument: (auth: AuthContext, kbId: string, id: string) => Promise<boolean | 'not_found'>;
  listDocumentChunks: (
    auth: AuthContext,
    kbId: string,
    documentId: string,
    options?: { search?: string | undefined; limit?: number | undefined; offset?: number | undefined },
  ) => Promise<{ rows: unknown[]; total: number }>;
  // ─── 资源（图片）────────────────────────────────────────────────
  createAssetUpload: (
    auth: AuthContext,
    input: {
      kbId: string;
      assetId?: string | undefined;
      documentId?: string | null | undefined;
      relPath: string;
      name: string;
      mime: string;
      sizeBytes: number;
      sha256: string;
      objectKey: string;
    },
  ) => Promise<any | null>;
  confirmAssetUpload: (
    auth: AuthContext,
    kbId: string,
    id: string,
    input: { sizeBytes: number; sha256: string; metadata?: Record<string, unknown> | undefined },
  ) => Promise<{ asset: any } | null>;
  getKnowledgeAsset: (auth: AuthContext, kbId: string, id: string) => Promise<any | null>;
  listKnowledgeAssets: (
    auth: AuthContext,
    kbId: string,
    options?: { documentId?: string | undefined; limit?: number | undefined; offset?: number | undefined },
  ) => Promise<any[]>;
  deleteKnowledgeAsset: (auth: AuthContext, kbId: string, id: string) => Promise<boolean>;
  listAssetsByRefs: (
    auth: AuthContext,
    kbId: string,
    refs: Array<{ documentId: string; relPath: string }>,
  ) => Promise<Map<string, any>>;
  attachAssetsToDocument: (tenantId: string, kbId: string, documentId: string) => Promise<void>;
  // ─── VLM caption（图片资源）────────────────────────────────
  enqueueCaptionJob: (input: { tenantId: string; kbId: string; assetId: string; maxAttempts?: number }) => Promise<{ id: string; job: unknown } | null>;
  listDocumentAssetsForIndexing: (
    tenantId: string,
    kbId: string,
    documentId: string,
    options?: { onlyWithCaption?: boolean; captionStatus?: 'ready' },
  ) => Promise<unknown[]>;
  enqueueReindexIfAttached: (tenantId: string, kbId: string, documentId: string, reason: string) => Promise<{ id: string } | null>;
}

export interface ApiServices {
  config: ApiConfig;
  repository: AgentRepository;
  knowledgeRepository?: KnowledgeRepositoryApi;
  queue: Queue;
  memoryIndexQueue?: Queue;
  publisher: Redis;
  artifacts: S3ArtifactStore;
  knowledgeQueue: Queue;
  captionQueue?: Queue;
  outbox: RunOutboxDispatcher;
  streamSubscriptions: StreamSubscriptionHub;
  observability?: ApiObservability;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}
