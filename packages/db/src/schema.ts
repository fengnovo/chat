import {
  boolean,
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  externalSubject: text('external_subject').unique(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull().default('empty'),
  sourceRef: text('source_ref'),
  sourceRevision: text('source_revision'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    projectId: uuid('project_id').references(() => projects.id),
    path: text('path').notNull(),
    sandboxId: text('sandbox_id'),
    sandboxProvider: text('sandbox_provider').notNull().default('e2b'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('workspaces_tenant_path_idx').on(table.tenantId, table.path)],
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    projectId: uuid('project_id').references(() => projects.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    externalKey: text('external_key'),
    title: text('title').notNull(),
    approvalMode: text('approval_mode').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_sessions_tenant_updated_idx').on(table.tenantId, table.updatedAt),
    uniqueIndex('agent_sessions_tenant_external_idx').on(table.tenantId, table.externalKey),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    sessionId: uuid('session_id').notNull().references(() => agentSessions.id),
    status: text('status').notNull(),
    userMessage: text('user_message').notNull(),
    knowledgeBaseIds: uuid('knowledge_base_ids').array().notNull().default([]),
    idempotencyKey: text('idempotency_key'),
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_runs_tenant_idempotency_idx').on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index('agent_runs_tenant_created_idx').on(table.tenantId, table.createdAt),
  ],
);

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    description: text('description'),
    visibility: text('visibility').notNull().default('private'),
    embeddingProfileKey: text('embedding_profile_key').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embeddingDim: integer('embedding_dim').notNull(),
    collectionName: text('collection_name').notNull(),
    chunkSize: integer('chunk_size').notNull(),
    chunkOverlap: integer('chunk_overlap').notNull(),
    topK: integer('top_k').notNull(),
    maxHops: integer('max_hops').notNull(),
    graphEnabled: boolean('graph_enabled').notNull().default(true),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('knowledge_bases_tenant_status_idx')
      .on(table.tenantId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    index('knowledge_bases_tenant_owner_idx')
      .on(table.tenantId, table.ownerUserId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey(),
    kbId: uuid('kb_id').notNull().references(() => knowledgeBases.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentHash: text('content_hash').notNull(),
    objectKey: text('object_key').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    chunkCount: integer('chunk_count').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('knowledge_documents_tenant_kb_idx')
      .on(table.tenantId, table.kbId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex('knowledge_documents_active_content_hash_idx')
      .on(table.kbId, table.contentHash)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey(),
    kbId: uuid('kb_id').notNull().references(() => knowledgeBases.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    heading: text('heading'),
    metadata: jsonb('metadata').notNull().default({}),
    vectorPointId: text('vector_point_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('knowledge_chunks_document_ordinal_idx').on(
      table.documentId,
      table.ordinal,
    ),
    uniqueIndex('knowledge_chunks_vector_point_idx').on(table.vectorPointId),
    index('knowledge_chunks_tenant_kb_document_idx').on(
      table.tenantId,
      table.kbId,
      table.documentId,
      table.ordinal,
    ),
  ],
);

export const graphEntities = pgTable(
  'graph_entities',
  {
    id: uuid('id').primaryKey(),
    kbId: uuid('kb_id').notNull().references(() => knowledgeBases.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id),
    entityKey: text('entity_key').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    description: text('description'),
    chunkIds: uuid('chunk_ids').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('graph_entities_kb_document_key_idx').on(
      table.kbId,
      table.documentId,
      table.entityKey,
    ),
    index('graph_entities_tenant_kb_key_idx').on(table.tenantId, table.kbId, table.entityKey),
    index('graph_entities_chunk_ids_gin_idx').using('gin', table.chunkIds),
  ],
);

export const graphRelationships = pgTable(
  'graph_relationships',
  {
    id: uuid('id').primaryKey(),
    kbId: uuid('kb_id').notNull().references(() => knowledgeBases.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id),
    sourceKey: text('source_key').notNull(),
    targetKey: text('target_key').notNull(),
    relation: text('relation').notNull(),
    description: text('description'),
    chunkIds: uuid('chunk_ids').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('graph_relationships_tenant_kb_source_idx').on(table.tenantId, table.kbId, table.sourceKey),
    index('graph_relationships_tenant_kb_target_idx').on(table.tenantId, table.kbId, table.targetKey),
    index('graph_relationships_chunk_ids_gin_idx').using('gin', table.chunkIds),
  ],
);

export const knowledgeIndexJobs = pgTable(
  'knowledge_index_jobs',
  {
    id: uuid('id').primaryKey(),
    kbId: uuid('kb_id').notNull().references(() => knowledgeBases.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    progress: integer('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_index_jobs_tenant_status_idx').on(table.tenantId, table.status, table.nextAttemptAt),
    index('knowledge_index_jobs_document_idx').on(table.tenantId, table.documentId),
  ],
);

export const knowledgeRetrievalLogs = pgTable(
  'knowledge_retrieval_logs',
  {
    id: uuid('id').primaryKey(),
    retrievalId: uuid('retrieval_id').notNull(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    sessionId: uuid('session_id').notNull().references(() => agentSessions.id),
    runId: uuid('run_id').notNull().references(() => agentRuns.id),
    kbIds: uuid('kb_ids').array().notNull(),
    query: text('query').notNull(),
    topK: integer('top_k').notNull(),
    maxHops: integer('max_hops').notNull(),
    resultCount: integer('result_count').notNull(),
    rerankStatus: text('rerank_status').notNull(),
    citations: jsonb('citations').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_retrieval_logs_tenant_run_idx').on(
      table.tenantId,
      table.runId,
      table.createdAt.desc(),
    ),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    runId: uuid('run_id').notNull().references(() => agentRuns.id),
    name: text('name').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('artifacts_tenant_object_key_idx').on(table.tenantId, table.objectKey),
    index('artifacts_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id').notNull().references(() => agentRuns.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    seq: integer('seq').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    index('run_events_tenant_run_idx').on(table.tenantId, table.runId, table.seq),
  ],
);

export const runDispatchOutbox = pgTable(
  'run_dispatch_outbox',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    runId: uuid('run_id').notNull().references(() => agentRuns.id),
    jobKind: text('job_kind').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('run_dispatch_outbox_pending_idx').on(table.availableAt, table.createdAt),
    index('run_dispatch_outbox_run_idx').on(table.tenantId, table.runId, table.createdAt),
    index('run_dispatch_outbox_unconsumed_idx').on(table.publishedAt, table.createdAt),
  ],
);
