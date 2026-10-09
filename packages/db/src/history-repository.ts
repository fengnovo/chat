import type { AgentEvent, AuthContext, PersistedAgentEvent, RunMessageProjection } from '@repo/contracts';
import type { Pool, QueryResultRow } from 'pg';
import type { RunRecord } from './repository.js';

export type ProjectedRunRecord = RunRecord & { projection: RunMessageProjection };
export interface HistoryRunPage { runs: ProjectedRunRecord[]; nextCursor: string | null; hasMore: boolean }
export interface HistoryFilePage {
  files: Array<{ path: string; content: string | null; operation: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

function runOf(row: QueryResultRow): RunRecord {
  return {
    id: row.id, tenantId: row.tenant_id, userId: row.user_id, sessionId: row.session_id, status: row.status,
    userMessage: row.user_message, continuation: Boolean(row.continuation), knowledgeBaseIds: row.knowledge_base_ids ?? [],
    lastEventSeq: Number(row.last_event_seq), cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    errorCode: row.error_code ?? null, errorMessage: row.error_message ?? null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function cursorOf(value?: string): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (typeof parsed.createdAt === 'string' && parsed.createdAt.length < 64 && Number.isFinite(Date.parse(parsed.createdAt)) &&
      typeof parsed.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parsed.id)) return parsed;
  } catch { /* 执行 SQL 前会报告无效游标。 */ }
  throw new Error('invalid_history_cursor');
}

const authorized = `r.tenant_id=$1 AND r.user_id=$2 AND r.session_id=$3
  AND EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=r.session_id AND s.tenant_id=$1 AND s.user_id=$2 AND s.deleted_at IS NULL)`;

export class HistoryRepository {
  constructor(private readonly pool: Pool) {}

  private async projections(rows: QueryResultRow[]): Promise<ProjectedRunRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    let result = await this.pool.query('SELECT * FROM run_message_projections WHERE run_id=ANY($1::uuid[])', [ids]);
    const existing = new Set(result.rows.map((row) => row.run_id));
    for (const row of rows) {
      if (!existing.has(row.id)) await this.pool.query('SELECT rebuild_run_message_projection($1,$2)', [row.id, row.tenant_id]);
    }
    if (existing.size !== rows.length) result = await this.pool.query('SELECT * FROM run_message_projections WHERE run_id=ANY($1::uuid[])', [ids]);
    const byId = new Map(result.rows.map((row) => [row.run_id, row]));
    return rows.map((row) => {
      const projected = byId.get(row.id);
      return { ...runOf(row), projection: { text: projected?.assistant_text ?? '', reasoning: projected?.reasoning ?? '',
        citations: projected?.citations ?? [], lastSeq: Number(projected?.last_seq ?? 0) } };
    });
  }

  async pageRuns(context: AuthContext, sessionId: string, options: { limit?: number; cursor?: string } = {}): Promise<HistoryRunPage> {
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)));
    const cursor = cursorOf(options.cursor);
    const result = await this.pool.query(`SELECT r.*,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM agent_runs r WHERE ${authorized}
      AND ($4::timestamptz IS NULL OR (r.created_at,r.id)<($4::timestamptz,$5::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT $6`,
      [context.tenantId, context.userId, sessionId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: last.id })).toString('base64url') : null;
    return { runs: await this.projections(rows.reverse()), nextCursor, hasMore };
  }

  async latestRun(context: AuthContext, sessionId: string): Promise<ProjectedRunRecord | null> {
    const result = await this.pool.query(`SELECT r.* FROM agent_runs r WHERE ${authorized} ORDER BY r.created_at DESC,r.id DESC LIMIT 1`, [context.tenantId, context.userId, sessionId]);
    return (await this.projections(result.rows))[0] ?? null;
  }

  async firstUserRun(context: AuthContext, sessionId: string): Promise<RunRecord | null> {
    const result = await this.pool.query(`SELECT r.* FROM agent_runs r WHERE ${authorized} AND NOT r.continuation ORDER BY r.created_at,r.id LIMIT 1`, [context.tenantId, context.userId, sessionId]);
    return result.rows[0] ? runOf(result.rows[0]) : null;
  }

  async latestEvents(context: AuthContext, runId: string, requestedLimit = 500): Promise<PersistedAgentEvent[]> {
    const limit = Math.min(500, Math.max(1, Math.trunc(requestedLimit)));
    const result = await this.pool.query<{ seq: number; payload: AgentEvent }>(`SELECT e.seq,e.payload FROM run_events e
      JOIN agent_runs r ON r.id=e.run_id AND r.tenant_id=e.tenant_id
      JOIN agent_sessions s ON s.id=r.session_id AND s.tenant_id=r.tenant_id
      LEFT JOIN interrupts i ON i.tenant_id=e.tenant_id AND i.run_id=e.run_id AND i.id=e.payload->>'interruptId'
      WHERE e.tenant_id=$1 AND r.user_id=$2 AND e.run_id=$3 AND s.user_id=$2 AND s.deleted_at IS NULL
        AND NOT(e.event_type IN('approval.required','question.required') AND COALESCE(i.status IN('resolved','cancelled'),false))
      ORDER BY e.seq DESC LIMIT $4`, [context.tenantId, context.userId, runId, limit]);
    return result.rows.reverse().map((row) => ({ ...row.payload, seq: row.seq }) as PersistedAgentEvent);
  }

  async listFiles(context: AuthContext, sessionId: string, options: { limit?: number; cursor?: string } = {}): Promise<HistoryFilePage> {
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)));
    let after = '';
    if (options.cursor) {
      try { after = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()).path; } catch { throw new Error('invalid_files_cursor'); }
      if (typeof after !== 'string' || !after || after.length > 1024) throw new Error('invalid_files_cursor');
    }
    const result = await this.pool.query(`SELECT f.path,f.content,f.operation FROM session_file_projections f
      JOIN agent_sessions s ON s.id=f.session_id AND s.tenant_id=f.tenant_id
      WHERE f.tenant_id=$1 AND s.user_id=$2 AND f.session_id=$3 AND s.deleted_at IS NULL AND f.path>$4
      ORDER BY f.path LIMIT $5`, [context.tenantId, context.userId, sessionId, after, limit + 1]);
    const files = result.rows.slice(0, limit) as HistoryFilePage['files'];
    const hasMore = result.rows.length > limit;
    return { files, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ path: files.at(-1)!.path })).toString('base64url') : null };
  }
}
