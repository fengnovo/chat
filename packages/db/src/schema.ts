import {
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    projectId: uuid('project_id').references(() => projects.id),
    path: text('path').notNull(),
    sandboxProvider: text('sandbox_provider').notNull().default('local'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
