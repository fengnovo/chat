import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AuthContext,
  PersistedAgentEvent,
  RunJob,
  RunStatus,
  WorkspaceSource,
} from '@repo/contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface SessionRecord {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  externalKey: string | null;
  projectId: string | null;
  workspaceId: string;
  workspacePath: string;
  approvalMode: 'manual' | 'session';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  sourceType: WorkspaceSource['type'];
  sourceRef: string | null;
  sourceRevision: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListCursor {
  updatedAt: string;
  id: string;
}

export interface RunRecord {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  status: RunStatus;
  userMessage: string;
  lastEventSeq: number;
  cancelRequestedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InterruptRecord {
  id: string;
  runId: string;
  kind: 'approval' | 'question';
  request: unknown;
  response: unknown;
}

export interface CancellationResult {
  run: RunRecord;
  event: PersistedAgentEvent | null;
}

export interface ArtifactRecord {
  id: string;
  tenantId: string;
  runId: string;
  name: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  status: 'pending' | 'ready';
  createdAt: string;
  uploadedAt: string | null;
}

export interface DispatchOutboxRecord {
  id: string;
  tenantId: string;
  runId: string;
  job: RunJob;
  attempts: number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sessionOf(row: QueryResultRow): SessionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    title: String(row.title),
    externalKey: row.external_key ? String(row.external_key) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    workspaceId: String(row.workspace_id),
    workspacePath: String(row.workspace_path),
    approvalMode: row.approval_mode as 'manual' | 'session',
    createdAt: iso(row.created_at as Date),
    updatedAt: iso(row.updated_at as Date),
  };
}

function projectOf(row: QueryResultRow): ProjectRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    sourceType: row.source_type as WorkspaceSource['type'],
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    sourceRevision:
      row.source_revision ? String(row.source_revision) : null,
    createdAt: iso(row.created_at as Date),
    updatedAt: iso(row.updated_at as Date),
  };
}

function workspaceSourceOf(row: QueryResultRow): WorkspaceSource | undefined {
  if (!row.source_type) return undefined;
  if (row.source_type === 'empty') return { type: 'empty' };
  if (row.source_type === 'git' && row.source_ref) {
    return {
      type: 'git',
      url: String(row.source_ref),
      ...(row.source_revision
        ? { ref: String(row.source_revision) }
        : {}),
    };
  }
  if (row.source_type === 'upload' && row.source_ref) {
    return { type: 'upload', objectKey: String(row.source_ref) };
  }
  throw new Error('Project workspace source is incomplete');
}

function runOf(row: QueryResultRow): RunRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    status: row.status as RunStatus,
    userMessage: String(row.user_message),
    lastEventSeq: Number(row.last_event_seq),
    cancelRequestedAt: row.cancel_requested_at ? iso(row.cancel_requested_at as Date) : null,
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: iso(row.created_at as Date),
    updatedAt: iso(row.updated_at as Date),
  };
}

function artifactOf(row: QueryResultRow): ArtifactRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    runId: String(row.run_id),
    name: String(row.name),
    objectKey: String(row.object_key),
    contentType: String(row.content_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    status: row.status as 'pending' | 'ready',
    createdAt: iso(row.created_at as Date),
    uploadedAt: row.uploaded_at ? iso(row.uploaded_at as Date) : null,
  };
}

async function inTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertDispatch(client: PoolClient, job: RunJob): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO run_dispatch_outbox
       (id, tenant_id, run_id, job_kind, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, job.tenantId, job.runId, job.kind, JSON.stringify(job)],
  );
  return id;
}

export class AgentRepository {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async ensureIdentity(context: AuthContext): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name) VALUES ($1, 'Agent tenant')
         ON CONFLICT (id) DO NOTHING`,
        [context.tenantId],
      );
      await client.query(
        `INSERT INTO users (id, display_name) VALUES ($1, 'Agent user')
         ON CONFLICT (id) DO NOTHING`,
        [context.userId],
      );
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [context.tenantId, context.userId, context.roles[0] ?? 'member'],
      );
    });
  }

  async createProject(
    context: AuthContext,
    input: {
      id?: string;
      name: string;
      sourceType: WorkspaceSource['type'];
      sourceRef?: string;
      sourceRevision?: string;
    },
  ): Promise<ProjectRecord> {
    const id = input.id ?? randomUUID();
    const result = await this.pool.query(
      `INSERT INTO projects
         (id, tenant_id, name, source_type, source_ref, source_revision)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        context.tenantId,
        input.name,
        input.sourceType,
        input.sourceRef ?? null,
        input.sourceRevision ?? null,
      ],
    );
    return projectOf(result.rows[0]);
  }

  async listProjects(context: AuthContext): Promise<ProjectRecord[]> {
    const result = await this.pool.query(
      `SELECT *
       FROM projects
       WHERE tenant_id = $1
       ORDER BY updated_at DESC, id DESC
       LIMIT 100`,
      [context.tenantId],
    );
    return result.rows.map(projectOf);
  }

  async getProject(
    context: AuthContext,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM projects WHERE tenant_id = $1 AND id = $2',
      [context.tenantId, projectId],
    );
    return result.rows[0] ? projectOf(result.rows[0]) : null;
  }

  async createSession(
    context: AuthContext,
    input: {
      title: string;
      projectId?: string;
      externalKey?: string;
      workspacePath: string;
    },
  ): Promise<SessionRecord> {
    return inTransaction(this.pool, async (client) => {
      if (input.projectId) {
        const project = await client.query(
          'SELECT 1 FROM projects WHERE tenant_id = $1 AND id = $2',
          [context.tenantId, input.projectId],
        );
        if (!project.rows[0]) throw new RepositoryNotFoundError('project');
      }
      const workspaceId = randomUUID();
      const sessionId = randomUUID();
      await client.query(
        `INSERT INTO workspaces (id, tenant_id, project_id, path)
         VALUES ($1, $2, $3, $4)`,
        [workspaceId, context.tenantId, input.projectId ?? null, input.workspacePath],
      );
      const result = await client.query(
        `INSERT INTO agent_sessions
           (id, tenant_id, user_id, project_id, workspace_id, external_key, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *, $8::text AS workspace_path`,
        [
          sessionId,
          context.tenantId,
          context.userId,
          input.projectId ?? null,
          workspaceId,
          input.externalKey ?? null,
          input.title,
          input.workspacePath,
        ],
      );
      return sessionOf(result.rows[0]);
    });
  }

  async getOrCreateExternalSession(
    context: AuthContext,
    input: {
      externalKey: string;
      title: string;
      workspacePath: string;
      projectId?: string;
    },
  ): Promise<SessionRecord> {
    return inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${context.tenantId}:${context.userId}:${input.externalKey}`,
      ]);
      const existing = await client.query(
        `SELECT s.*, w.path AS workspace_path
         FROM agent_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.external_key = $3
           AND s.deleted_at IS NULL`,
        [context.tenantId, context.userId, input.externalKey],
      );
      if (existing.rows[0]) {
        if (String(existing.rows[0].title) === '新会话' && input.title !== '新会话') {
          const renamed = await client.query(
            `UPDATE agent_sessions
             SET title = $4, updated_at = now()
             WHERE tenant_id = $1 AND user_id = $2 AND id = $3
             RETURNING *, $5::text AS workspace_path`,
            [
              context.tenantId,
              context.userId,
              String(existing.rows[0].id),
              input.title,
              String(existing.rows[0].workspace_path),
            ],
          );
          return sessionOf(renamed.rows[0]);
        }
        return sessionOf(existing.rows[0]);
      }

      if (input.projectId) {
        const project = await client.query(
          'SELECT 1 FROM projects WHERE tenant_id = $1 AND id = $2',
          [context.tenantId, input.projectId],
        );
        if (!project.rows[0]) throw new RepositoryNotFoundError('project');
      }

      const workspaceId = randomUUID();
      const sessionId = randomUUID();
      await client.query(
        `INSERT INTO workspaces (id, tenant_id, project_id, path)
         VALUES ($1, $2, $3, $4)`,
        [workspaceId, context.tenantId, input.projectId ?? null, input.workspacePath],
      );
      const created = await client.query(
        `INSERT INTO agent_sessions
           (id, tenant_id, user_id, project_id, workspace_id, external_key, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *, $8::text AS workspace_path`,
        [
          sessionId,
          context.tenantId,
          context.userId,
          input.projectId ?? null,
          workspaceId,
          input.externalKey,
          input.title,
          input.workspacePath,
        ],
      );
      return sessionOf(created.rows[0]);
    });
  }

  async listSessions(
    context: AuthContext,
    input: { limit: number; cursor?: SessionListCursor },
  ): Promise<SessionRecord[]> {
    const result = await this.pool.query(
      `SELECT s.*, w.path AS workspace_path
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL
         AND (
           $3::timestamptz IS NULL
           OR (s.updated_at, s.id) < ($3::timestamptz, $4::uuid)
         )
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT $5`,
      [
        context.tenantId,
        context.userId,
        input.cursor?.updatedAt ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ],
    );
    return result.rows.map(sessionOf);
  }

  async getSession(context: AuthContext, sessionId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      `SELECT s.*, w.path AS workspace_path
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.id = $3
         AND s.deleted_at IS NULL`,
      [context.tenantId, context.userId, sessionId],
    );
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }

  async renameSession(
    context: AuthContext,
    sessionId: string,
    title: string,
  ): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      `UPDATE agent_sessions AS s
       SET title = $4, updated_at = now()
       FROM workspaces w
       WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.id = $3
         AND s.deleted_at IS NULL AND w.id = s.workspace_id
       RETURNING s.*, w.path AS workspace_path`,
      [context.tenantId, context.userId, sessionId, title],
    );
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }

  async deleteSession(
    context: AuthContext,
    sessionId: string,
  ): Promise<'deleted' | 'active' | 'not_found'> {
    return inTransaction(this.pool, async (client) => {
      const session = await client.query(
        `SELECT id
         FROM agent_sessions
         WHERE tenant_id = $1 AND user_id = $2 AND id = $3
           AND deleted_at IS NULL
         FOR UPDATE`,
        [context.tenantId, context.userId, sessionId],
      );
      if (!session.rows[0]) return 'not_found';
      const activeRun = await client.query(
        `SELECT 1
         FROM agent_runs
         WHERE tenant_id = $1 AND session_id = $2
           AND status IN ('queued', 'running', 'waiting_approval', 'waiting_question')
         LIMIT 1`,
        [context.tenantId, sessionId],
      );
      if (activeRun.rows[0]) return 'active';
      await client.query(
        `UPDATE agent_sessions
         SET deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
        [context.tenantId, context.userId, sessionId],
      );
      return 'deleted';
    });
  }

  async listSessionRuns(context: AuthContext, sessionId: string): Promise<RunRecord[]> {
    const result = await this.pool.query(
      `SELECT *
       FROM agent_runs
       WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3
       ORDER BY created_at ASC`,
      [context.tenantId, context.userId, sessionId],
    );
    return result.rows.map(runOf);
  }

  async createRun(
    context: AuthContext,
    input: { sessionId: string; message: string; idempotencyKey?: string },
  ): Promise<{ run: RunRecord; created: boolean; outboxId?: string }> {
    return inTransaction(this.pool, async (client) => {
      if (input.idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM agent_runs WHERE tenant_id = $1 AND idempotency_key = $2`,
          [context.tenantId, input.idempotencyKey],
        );
        if (existing.rows[0]) return { run: runOf(existing.rows[0]), created: false };
      }

      const session = await client.query(
        `SELECT s.id, s.approval_mode, w.path AS workspace_path,
                p.source_type, p.source_ref, p.source_revision
         FROM agent_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         LEFT JOIN projects p ON p.id = s.project_id AND p.tenant_id = s.tenant_id
         WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.id = $3
           AND s.deleted_at IS NULL
         FOR UPDATE OF s`,
        [context.tenantId, context.userId, input.sessionId],
      );
      if (!session.rows[0]) throw new RepositoryNotFoundError('session');

      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO agent_runs
           (id, tenant_id, user_id, session_id, status, user_message, idempotency_key)
         VALUES ($1, $2, $3, $4, 'queued', $5, $6)
         RETURNING *`,
        [
          id,
          context.tenantId,
          context.userId,
          input.sessionId,
          input.message,
          input.idempotencyKey ?? null,
        ],
      );
      await client.query('UPDATE agent_sessions SET updated_at = now() WHERE id = $1', [
        input.sessionId,
      ]);
      const run = runOf(result.rows[0]);
      const workspaceSource = workspaceSourceOf(session.rows[0]);
      const outboxId = await insertDispatch(client, {
        kind: 'start',
        tenantId: context.tenantId,
        userId: context.userId,
        sessionId: input.sessionId,
        runId: run.id,
        message: input.message,
        workspacePath: String(session.rows[0].workspace_path),
        approvalMode: session.rows[0].approval_mode as 'manual' | 'session',
        ...(workspaceSource ? { workspaceSource } : {}),
      });
      return { run, created: true, outboxId };
    });
  }

  async claimDispatches(limit: number, leaseMs: number): Promise<DispatchOutboxRecord[]> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(
        `WITH candidates AS (
           SELECT id
           FROM run_dispatch_outbox
           WHERE published_at IS NULL
             AND available_at <= now()
             AND (
               locked_at IS NULL
               OR locked_at < now() - ($2::integer * interval '1 millisecond')
             )
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE run_dispatch_outbox AS dispatch
         SET locked_at = now(), attempts = dispatch.attempts + 1
         FROM candidates
         WHERE dispatch.id = candidates.id
         RETURNING dispatch.*`,
        [limit, leaseMs],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        runId: String(row.run_id),
        job: row.payload as RunJob,
        attempts: Number(row.attempts),
      }));
    });
  }

  async markDispatchPublished(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE run_dispatch_outbox
       SET published_at = now(), locked_at = NULL, last_error = NULL
       WHERE id = $1`,
      [id],
    );
  }

  async markDispatchConsumed(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE run_dispatch_outbox
       SET consumed_at = COALESCE(consumed_at, now())
       WHERE id = $1`,
      [id],
    );
  }

  async requeueStaleDispatches(staleMs: number, limit: number): Promise<number> {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT dispatch.id
         FROM run_dispatch_outbox dispatch
         JOIN agent_runs run ON run.id = dispatch.run_id
         WHERE dispatch.published_at IS NOT NULL
           AND dispatch.consumed_at IS NULL
           AND dispatch.published_at < now() - ($1::integer * interval '1 millisecond')
           AND run.cancel_requested_at IS NULL
           AND (
             (dispatch.job_kind = 'start' AND run.status = 'queued')
             OR (dispatch.job_kind = 'resume-approval' AND run.status = 'waiting_approval')
             OR (dispatch.job_kind = 'resume-question' AND run.status = 'waiting_question')
           )
         ORDER BY dispatch.published_at ASC
         FOR UPDATE OF dispatch SKIP LOCKED
         LIMIT $2
       )
       UPDATE run_dispatch_outbox AS dispatch
       SET published_at = NULL, locked_at = NULL, available_at = now(),
           last_error = 'requeued by stale dispatch reconciler'
       FROM candidates
       WHERE dispatch.id = candidates.id
       RETURNING dispatch.id`,
      [staleMs, limit],
    );
    return result.rowCount ?? 0;
  }

  async rescheduleDispatch(id: string, error: string, delayMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE run_dispatch_outbox
       SET locked_at = NULL,
           available_at = now() + ($3::integer * interval '1 millisecond'),
           last_error = left($2, 4000)
       WHERE id = $1 AND published_at IS NULL`,
      [id, error, delayMs],
    );
  }

  async getRun(context: AuthContext, runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM agent_runs WHERE tenant_id = $1 AND id = $2',
      [context.tenantId, runId],
    );
    return result.rows[0] ? runOf(result.rows[0]) : null;
  }

  async getRunForWorker(tenantId: string, runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM agent_runs WHERE tenant_id = $1 AND id = $2',
      [tenantId, runId],
    );
    return result.rows[0] ? runOf(result.rows[0]) : null;
  }

  async updateRunStatus(
    tenantId: string,
    runId: string,
    status: RunStatus,
    error?: { code: string; message: string },
  ): Promise<void> {
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    const result = await this.pool.query(
      `UPDATE agent_runs
       SET status = $3,
           started_at = CASE WHEN $3 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
           finished_at = CASE WHEN $4 THEN now() ELSE finished_at END,
           error_code = $5,
           error_message = $6,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId, status, terminal, error?.code ?? null, error?.message ?? null],
    );
    if (result.rowCount !== 1) throw new RepositoryNotFoundError('run');
  }

  async tryMarkRunRunning(tenantId: string, runId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_runs
       SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE tenant_id = $1 AND id = $2
         AND status IN ('queued', 'running', 'waiting_approval', 'waiting_question')
         AND cancel_requested_at IS NULL`,
      [tenantId, runId],
    );
    return result.rowCount === 1;
  }

  async appendEvent(tenantId: string, event: AgentEvent): Promise<PersistedAgentEvent> {
    return inTransaction(this.pool, async (client) => {
      const sequence = await client.query<{ last_event_seq: number }>(
        `UPDATE agent_runs
         SET last_event_seq = last_event_seq + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING last_event_seq`,
        [tenantId, event.runId],
      );
      const seq = sequence.rows[0]?.last_event_seq;
      if (!seq) throw new RepositoryNotFoundError('run');
      await client.query(
        `INSERT INTO run_events (run_id, tenant_id, seq, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [event.runId, tenantId, seq, event.type, JSON.stringify(event)],
      );
      return { ...event, seq } as PersistedAgentEvent;
    });
  }

  async listEvents(
    context: AuthContext,
    runId: string,
    afterSeq: number,
    limit = 500,
  ): Promise<PersistedAgentEvent[]> {
    const result = await this.pool.query<{ seq: number; payload: AgentEvent }>(
      `SELECT seq, payload
       FROM run_events
       WHERE tenant_id = $1 AND run_id = $2 AND seq > $3
       ORDER BY seq ASC
       LIMIT $4`,
      [context.tenantId, runId, afterSeq, limit],
    );
    return result.rows.map((row) => ({ ...row.payload, seq: row.seq }) as PersistedAgentEvent);
  }

  async createInterrupt(
    tenantId: string,
    runId: string,
    interrupt: { id: string; kind: 'approval' | 'question'; request: unknown },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO interrupts (id, tenant_id, run_id, kind, request)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (run_id, id) DO NOTHING`,
      [interrupt.id, tenantId, runId, interrupt.kind, JSON.stringify(interrupt.request)],
    );
  }

  async resolveInterrupt(
    context: AuthContext,
    runId: string,
    interruptId: string,
    kind: 'approval' | 'question',
    response: unknown,
  ): Promise<InterruptRecord | null> {
    return inTransaction(this.pool, async (client) => {
      const run = await client.query(
        `SELECT r.user_id, r.session_id, w.path AS workspace_path,
                s.approval_mode
         FROM agent_runs r
         JOIN agent_sessions s ON s.id = r.session_id
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE r.tenant_id = $1 AND r.user_id = $2 AND r.id = $3
           AND s.deleted_at IS NULL
         FOR UPDATE OF s`,
        [context.tenantId, context.userId, runId],
      );
      if (!run.rows[0]) throw new RepositoryNotFoundError('run');

      const result = await client.query(
        `UPDATE interrupts
         SET status = 'resolved', response = $5::jsonb, resolved_at = now()
         WHERE tenant_id = $1 AND run_id = $2 AND id = $3 AND kind = $4
           AND status = 'pending'
         RETURNING *`,
        [context.tenantId, runId, interruptId, kind, JSON.stringify(response)],
      );
      const row = result.rows[0];
      if (!row) return null;
      const approvalDecision =
        kind === 'approval'
          ? (response as Extract<RunJob, { kind: 'resume-approval' }>['decision'])
          : null;
      const grantsSessionApproval =
        approvalDecision?.decision === 'approve' &&
        approvalDecision.scope === 'session';
      if (grantsSessionApproval) {
        await client.query(
          `UPDATE agent_sessions
           SET approval_mode = 'session', updated_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
          [context.tenantId, context.userId, String(run.rows[0].session_id)],
        );
      }
      const approvalMode = grantsSessionApproval
        ? 'session'
        : (run.rows[0].approval_mode as 'manual' | 'session');
      const common = {
        tenantId: context.tenantId,
        userId: String(run.rows[0].user_id),
        sessionId: String(run.rows[0].session_id),
        runId,
        workspacePath: String(run.rows[0].workspace_path),
        approvalMode,
      };
      const job: RunJob =
        kind === 'approval'
          ? {
              ...common,
              kind: 'resume-approval',
              decision: response as Extract<
                RunJob,
                { kind: 'resume-approval' }
              >['decision'],
            }
          : {
              ...common,
              kind: 'resume-question',
              answer: response as Extract<
                RunJob,
                { kind: 'resume-question' }
              >['answer'],
            };
      await insertDispatch(client, job);
      return {
        id: String(row.id),
        runId: String(row.run_id),
        kind: row.kind as 'approval' | 'question',
        request: row.request,
        response: row.response,
      };
    });
  }

  async requestCancellation(
    context: AuthContext,
    runId: string,
  ): Promise<CancellationResult | null> {
    return inTransaction(this.pool, async (client) => {
      const selected = await client.query(
        `SELECT * FROM agent_runs
         WHERE tenant_id = $1 AND id = $2
           AND status IN ('queued', 'running', 'waiting_approval', 'waiting_question')
         FOR UPDATE`,
        [context.tenantId, runId],
      );
      const current = selected.rows[0];
      if (!current) return null;

      if (current.status === 'running') {
        const updated = await client.query(
          `UPDATE agent_runs
           SET cancel_requested_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND id = $2
           RETURNING *`,
          [context.tenantId, runId],
        );
        return { run: runOf(updated.rows[0]), event: null };
      }

      const seq = Number(current.last_event_seq) + 1;
      const event: PersistedAgentEvent = {
        runId,
        seq,
        timestamp: new Date().toISOString(),
        type: 'run.cancelled',
      };
      const updated = await client.query(
        `UPDATE agent_runs
         SET status = 'cancelled', cancel_requested_at = now(),
             last_event_seq = $3, finished_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [context.tenantId, runId, seq],
      );
      await client.query(
        `INSERT INTO run_events (run_id, tenant_id, seq, event_type, payload)
         VALUES ($1, $2, $3, 'run.cancelled', $4::jsonb)`,
        [runId, context.tenantId, seq, JSON.stringify(event)],
      );
      await client.query(
        `UPDATE interrupts
         SET status = 'cancelled', resolved_at = now()
         WHERE tenant_id = $1 AND run_id = $2 AND status = 'pending'`,
        [context.tenantId, runId],
      );
      await client.query(
        `UPDATE run_dispatch_outbox
         SET published_at = now(), locked_at = NULL,
             last_error = 'cancelled before dispatch'
         WHERE tenant_id = $1 AND run_id = $2 AND published_at IS NULL`,
        [context.tenantId, runId],
      );
      return { run: runOf(updated.rows[0]), event };
    });
  }

  async createArtifact(
    context: AuthContext,
    input: {
      id: string;
      runId: string;
      name: string;
      objectKey: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    },
  ): Promise<ArtifactRecord> {
    const result = await this.pool.query(
      `INSERT INTO artifacts
         (id, tenant_id, run_id, name, object_key, content_type, size_bytes, sha256)
       SELECT $1, $2, r.id, $4, $5, $6, $7, $8
       FROM agent_runs r
       WHERE r.tenant_id = $2 AND r.id = $3
       RETURNING *`,
      [
        input.id,
        context.tenantId,
        input.runId,
        input.name,
        input.objectKey,
        input.contentType,
        input.sizeBytes,
        input.sha256,
      ],
    );
    if (!result.rows[0]) throw new RepositoryNotFoundError('run');
    return artifactOf(result.rows[0]);
  }

  async getArtifact(
    context: AuthContext,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM artifacts WHERE tenant_id = $1 AND id = $2',
      [context.tenantId, artifactId],
    );
    return result.rows[0] ? artifactOf(result.rows[0]) : null;
  }

  async markArtifactReady(
    context: AuthContext,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    const result = await this.pool.query(
      `UPDATE artifacts
       SET status = 'ready', uploaded_at = COALESCE(uploaded_at, now())
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
       RETURNING *`,
      [context.tenantId, artifactId],
    );
    if (result.rows[0]) return artifactOf(result.rows[0]);
    return this.getArtifact(context, artifactId);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class RepositoryNotFoundError extends Error {
  constructor(public readonly resource: string) {
    super(`${resource} not found`);
    this.name = 'RepositoryNotFoundError';
  }
}
