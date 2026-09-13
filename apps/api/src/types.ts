import type { S3ArtifactStore } from '@repo/artifacts';
import type { AuthContext } from '@repo/contracts';
import type { AgentRepository } from '@repo/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { ApiConfig } from './config.js';
import type { RunOutboxDispatcher } from './outbox.js';
import type { StreamSubscriptionHub } from './stream-subscriptions.js';

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
}

export interface ApiServices {
  config: ApiConfig;
  repository: AgentRepository;
  knowledgeRepository?: KnowledgeRepositoryApi;
  queue: Queue;
  publisher: Redis;
  artifacts: S3ArtifactStore;
  knowledgeQueue: Queue;
  outbox: RunOutboxDispatcher;
  streamSubscriptions: StreamSubscriptionHub;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}
