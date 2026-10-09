import { randomUUID } from 'node:crypto';
import type { AgentEvent, PersistedAgentEvent, RunJob } from '@repo/contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface RunExecutionLease {
  tenantId: string;
  runId: string;
  token: string;
  epoch: number;
  input: Exclude<RunJob, { kind: 'recover' }>;
  recovery: boolean;
  legacyExecution?: boolean;
}

export interface ToolExecutionRecord {
  executionId: string;
  idempotencyKey: string;
  scopeId: string;
  toolCallId: string;
  toolName: string;
  inputHash: string;
  status: 'started' | 'succeeded' | 'uncertain';
  result: unknown | null;
  replayPolicy: 'safe' | 'unsafe';
  retryCount: number;
}

export interface ChildExecutionRecord {
  id: string;
  parentToolCallId: string;
  threadId: string;
  input: unknown;
  background: boolean;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  feedback: string | null;
  attemptResult: { status: 'completed' | 'failed' | 'timeout'; summary: string; toolCalls: number } | null;
  summary: string | null;
  review: unknown | null;
}

export class LeaseLostError extends Error {
  readonly code = 'EXECUTION_LEASE_LOST';
  constructor() { super('The execution lease is no longer owned by this worker.'); this.name = 'LeaseLostError'; }
}

export class ExecutionIdentityError extends Error {
  readonly code = 'EXECUTION_IDENTITY_CONFLICT';
  constructor(message: string) { super(message); this.name = 'ExecutionIdentityError'; }
}

export class ExecutionCompatibilityError extends Error {
  constructor(readonly code: 'RECOVERY_INCOMPATIBLE' | 'RECOVERY_DESCRIPTOR_MISSING', component: string) {
    super(code === 'RECOVERY_DESCRIPTOR_MISSING'
      ? `The ${component} execution descriptor required for safe continuation is missing. Start a new run after reviewing prior tool effects.`
      : `The ${component} execution configuration changed. This run cannot continue safely; restore its original runtime or start a new run after reviewing prior tool effects.`);
    this.name = 'ExecutionCompatibilityError';
  }
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ExecutionIdentityError('Execution input and result must be JSON serializable.');
  return encoded;
}

function toolOf(row: QueryResultRow): ToolExecutionRecord {
  return {
    executionId: row.execution_id, idempotencyKey: row.idempotency_key,
    scopeId: row.scope_id, toolCallId: row.tool_call_id, toolName: row.tool_name,
    inputHash: row.input_hash, status: row.status, result: row.result, replayPolicy: row.replay_policy, retryCount: row.retry_count,
  };
}

function childOf(row: QueryResultRow): ChildExecutionRecord {
  return {
    id: row.id, parentToolCallId: row.parent_tool_call_id, threadId: row.thread_id,
    input: row.input, background: row.background, status: row.status,
    attempt: row.attempt, feedback: row.feedback, attemptResult: row.attempt_result,
    summary: row.summary, review: row.review,
  };
}

const terminalStatuses = ['completed', 'failed', 'cancelled'];

export class DurableExecutionRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private validateDuration(leaseMs: number): void {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Execution lease duration must be positive.');
  }

  private async lockLease(client: PoolClient, lease: RunExecutionLease): Promise<QueryResultRow> {
    // 获取锁后再检查 TTL，因为等待期间其他所有者可能已完成提交。
    const selected = await client.query('SELECT * FROM agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [lease.tenantId, lease.runId]);
    const row = selected.rows[0];
    if (!row || row.lease_token !== lease.token || Number(row.lease_epoch) !== lease.epoch) throw new LeaseLostError();
    const valid = await client.query('SELECT lease_expires_at > clock_timestamp() AS valid FROM agent_runs WHERE tenant_id=$1 AND id=$2', [lease.tenantId, lease.runId]);
    if (!valid.rows[0]?.valid) throw new LeaseLostError();
    return row;
  }

  async withLease<T>(lease: RunExecutionLease, action: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await this.lockLease(client, lease);
      const result = await action(client);
      // 所有权 TTL 到期后，耗时较长的写入不得提交。
      await this.lockLease(client, lease);
      return result;
    });
  }

  async assertLease(lease: RunExecutionLease): Promise<void> {
    await this.withLease(lease, async () => undefined);
  }

  async bindExecutionDescriptor(lease: RunExecutionLease, descriptor: Record<string, unknown>, component: 'host' | 'agent' = 'host'): Promise<void> {
    if (!descriptor || Array.isArray(descriptor) || Object.keys(descriptor).length === 0) throw new ExecutionIdentityError('Execution descriptor must be a nonempty JSON object.');
    const encoded = json(descriptor);
    await this.withLease(lease, async (client) => {
      const selected = await client.query(
        `SELECT execution_descriptor->$3 AS descriptor,(execution_descriptor->$3)=$4::jsonb AS compatible,
         execution_descriptor->'agent' AS agent_descriptor,
         execution_descriptor->'contractVersion'='1'::jsonb AS current_contract,
         last_event_seq=0
           AND NOT EXISTS(SELECT 1 FROM tool_executions t WHERE t.tenant_id=$1 AND t.run_id=$2)
           AND NOT EXISTS(SELECT 1 FROM child_executions c WHERE c.tenant_id=$1 AND c.root_run_id=$2) AS no_execution
         FROM agent_runs WHERE tenant_id=$1 AND id=$2`,
        [lease.tenantId, lease.runId, component, encoded],
      );
      const row = selected.rows[0]!;
      // 新 run 会在创建时标记。图构造前会先提交其 Agent 组件，
      // 因此缺少该组件就能证明准备过程尚未进入图或工具执行阶段。
      // 该阶段发生崩溃后可以安全地完成准备；未标记的旧 run 没有此类依据。
      const preparing = row.current_contract === true && row.no_execution === true && !row.agent_descriptor && lease.input.kind === 'start';
      if (row.descriptor) {
        if (!row.compatible) throw new ExecutionCompatibilityError('RECOVERY_INCOMPATIBLE', component);
        // 在宿主开始任何准备工作之前，拒绝缺少完整先前运行时身份的检查点。
        if (component === 'host' && (lease.recovery || lease.input.kind !== 'start') && !row.agent_descriptor && !preparing) {
          throw new ExecutionCompatibilityError('RECOVERY_DESCRIPTOR_MISSING', 'agent');
        }
        return;
      }
      if ((lease.recovery && !preparing) || lease.input.kind !== 'start') throw new ExecutionCompatibilityError('RECOVERY_DESCRIPTOR_MISSING', component);
      await client.query(
        `UPDATE agent_runs SET execution_descriptor=jsonb_set(COALESCE(execution_descriptor,'{}'::jsonb),ARRAY[$3::text],$4::jsonb) WHERE tenant_id=$1 AND id=$2`,
        [lease.tenantId, lease.runId, component, encoded],
      );
    });
  }

  private async invocationInput(client: PoolClient, row: QueryResultRow): Promise<RunExecutionLease['input'] | null> {
    if (row.execution_input && row.execution_input.kind !== 'recover') return row.execution_input;
    const dispatch = await client.query(
      `SELECT payload FROM run_dispatch_outbox WHERE tenant_id=$1 AND run_id=$2 AND job_kind <> 'recover'
       ORDER BY created_at DESC, id DESC LIMIT 1`, [row.tenant_id, row.id],
    );
    return dispatch.rows[0]?.payload ?? null;
  }

  async claimRun(job: RunJob, leaseMs: number, workerId: string, maxAttempts = 10): Promise<RunExecutionLease | null> {
    this.validateDuration(leaseMs);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 0) throw new Error('Recovery attempt budget must be a nonnegative integer.');
    return this.transaction(async (client) => {
      const selected = await client.query('SELECT * FROM agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [job.tenantId, job.runId]);
      const row = selected.rows[0];
      if (!row || terminalStatuses.includes(row.status) || row.execution_state === 'terminal') return null;
      if (row.user_id !== job.userId || row.session_id !== job.sessionId) throw new ExecutionIdentityError('Run invocation identity does not match its owner or session.');
      const live = await client.query('SELECT lease_token IS NOT NULL AND lease_expires_at > clock_timestamp() AS live FROM agent_runs WHERE id=$1', [job.runId]);
      if (live.rows[0]?.live) return null;
      const waiting = row.execution_state === 'waiting' || ['waiting_approval', 'waiting_question'].includes(row.status);
      const resuming = job.kind === 'resume-approval' || job.kind === 'resume-question';
      if (waiting && (!resuming || (row.status === 'waiting_approval' && job.kind !== 'resume-approval') || (row.status === 'waiting_question' && job.kind !== 'resume-question'))) return null;
      if (waiting && resuming) {
        const response = job.kind === 'resume-approval' ? job.decision : job.answer;
        const interrupt = await client.query(
          `SELECT i.id,i.status,i.response=$3::jsonb AS same_response,
           (SELECT MAX(e.seq) FROM run_events e WHERE e.run_id=i.run_id AND e.tenant_id=i.tenant_id
            AND e.payload->>'interruptId'=i.id) AS event_seq
           FROM interrupts i WHERE i.tenant_id=$1 AND i.run_id=$2
           ORDER BY event_seq DESC NULLS LAST,i.created_at DESC,i.id DESC LIMIT 1`,
          [job.tenantId, job.runId, json(response)],
        );
        const latest = interrupt.rows[0];
        if (latest && (latest.status !== 'resolved' || !latest.same_response || (job.interruptId && latest.id !== job.interruptId))) return null;
        if (job.interruptId && !latest) return null;
        if (!job.interruptId) {
          // 只有最近一次持久化派发也是旧格式时，才接受旧载荷。
          const dispatch = await client.query(
            `SELECT payload FROM run_dispatch_outbox WHERE tenant_id=$1 AND run_id=$2 AND job_kind <> 'recover'
             ORDER BY created_at DESC,id DESC LIMIT 1`, [job.tenantId, job.runId],
          );
          if (dispatch.rows[0]?.payload.interruptId) return null;
        }
      }
      const recovery = !waiting && (row.execution_state === 'running' || row.execution_state === 'recovering');
      const directRecovery = recovery && row.execution_state === 'running';
      if (directRecovery && Number(row.recovery_attempts) >= maxAttempts) {
        await this.failRecovery(client, row, false);
        return null;
      }
      let input: RunExecutionLease['input'] | null;
      if (recovery || job.kind === 'recover') input = await this.invocationInput(client, row);
      else input = job as RunExecutionLease['input'];
      if (!input) throw new ExecutionIdentityError('Run recovery requires a persisted invocation input.');
      const token = randomUUID();
      const updated = await client.query(
        `UPDATE agent_runs SET status='running', execution_state='running', lease_token=$3,
         lease_epoch=lease_epoch+1, lease_expires_at=clock_timestamp()+($4::double precision * interval '1 millisecond'),
         worker_id=$5, execution_input=$6::jsonb,recovery_attempts=recovery_attempts+$7,
         started_at=COALESCE(started_at,clock_timestamp()),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 RETURNING lease_epoch`,
        [job.tenantId, job.runId, token, leaseMs, workerId, json(input), directRecovery ? 1 : 0],
      );
      return { tenantId: job.tenantId, runId: job.runId, token, epoch: Number(updated.rows[0]!.lease_epoch), input,
        recovery: recovery || job.kind === 'recover', legacyExecution: row.legacy_execution === true };
    });
  }

  async renewLease(lease: RunExecutionLease, leaseMs: number): Promise<boolean> {
    this.validateDuration(leaseMs);
    try {
      return await this.transaction(async (client) => {
        await this.lockLease(client, lease);
        await client.query('UPDATE agent_runs SET lease_expires_at=clock_timestamp()+($3::double precision * interval \'1 millisecond\'),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [lease.tenantId, lease.runId, leaseMs]);
        return true;
      });
    } catch (error) { if (error instanceof LeaseLostError) return false; throw error; }
  }

  async releaseLease(lease: RunExecutionLease, interrupted = false): Promise<void> {
    // 释放已过期所有者不会造成影响；绝不清除后继所有者的令牌。
    await this.pool.query(
      `UPDATE agent_runs SET lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,
       execution_state=CASE WHEN status IN ('completed','failed','cancelled') THEN 'terminal'
         WHEN status IN ('waiting_approval','waiting_question') THEN 'waiting'
         WHEN $5 THEN 'running' ELSE execution_state END,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND lease_epoch=$4`,
      [lease.tenantId, lease.runId, lease.token, lease.epoch, interrupted],
    );
  }

  private async failRecovery(client: PoolClient, row: QueryResultRow, missingInput: boolean): Promise<void> {
    const event: AgentEvent = row.cancel_requested_at ? {
      type: 'run.cancelled', runId: row.id, timestamp: new Date().toISOString(),
    } : {
      type: 'run.failed', runId: row.id, timestamp: new Date().toISOString(),
      code: missingInput ? 'RECOVERY_INPUT_MISSING' : 'RECOVERY_EXHAUSTED',
      message: missingInput ? 'The invocation input required to recover this run is missing.' : 'The run exhausted its crash recovery attempts.',
    };
    await this.insertEvent(client, row.tenant_id, event);
    await client.query('UPDATE agent_runs SET lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.id]);
  }

  async recoverExpiredRuns(limit: number, maxAttempts: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 0) throw new Error('Recovery limit and attempt budget must be nonnegative integers with a positive limit.');
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM agent_runs WHERE status='running'
         AND (execution_state='running' OR (execution_state='recovering' AND NOT EXISTS (
           SELECT 1 FROM run_dispatch_outbox dispatch WHERE dispatch.tenant_id=agent_runs.tenant_id
           AND dispatch.run_id=agent_runs.id AND dispatch.job_kind='recover' AND dispatch.consumed_at IS NULL
         ))) AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
         ORDER BY updated_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit],
      );
      for (const row of selected.rows) {
        const input = await this.invocationInput(client, row);
        if (Number(row.recovery_attempts) >= maxAttempts || !input) {
          await this.failRecovery(client, row, !input);
          continue;
        }
        const { tenantId, userId, sessionId, runId, workspacePath, knowledgeBaseIds, approvalMode, observability } = input;
        const recover = { kind: 'recover', tenantId, userId, sessionId, runId, workspacePath, knowledgeBaseIds, ...(approvalMode ? { approvalMode } : {}), ...(observability ? { observability } : {}) };
        await client.query(
          `UPDATE agent_runs SET execution_state='recovering',execution_input=$3::jsonb,
           recovery_attempts=recovery_attempts+1,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, row.id, json(input)],
        );
        await client.query('INSERT INTO run_dispatch_outbox(id,tenant_id,run_id,job_kind,payload) VALUES($1,$2,$3,\'recover\',$4::jsonb)', [randomUUID(), row.tenant_id, row.id, json(recover)]);
      }
      return selected.rows.length;
    });
  }

  private async insertEvent(client: PoolClient, tenantId: string, event: AgentEvent): Promise<PersistedAgentEvent> {
    const current = await client.query('SELECT status,cancel_requested_at FROM agent_runs WHERE tenant_id=$1 AND id=$2', [tenantId, event.runId]);
    if (!current.rows[0]) throw new ExecutionIdentityError('Cannot append an event to a missing run.');
    // 已持久化的取消状态不能被完成状态或新的暂停覆盖。
    if (current.rows[0].cancel_requested_at &&
      ['run.completed', 'approval.required', 'question.required'].includes(event.type)) {
      event = { runId: event.runId, timestamp: event.timestamp, type: 'run.cancelled' };
    }
    const terminal = ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type);
    const key = terminal ? 'terminal' : event.type === 'run.started' ? 'run.started' : event.type === 'approval.required' || event.type === 'question.required' ? `${event.type}:${event.interruptId}` : null;
    if (key) {
      const existing = await client.query('SELECT seq,payload FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND event_key=$3', [tenantId, event.runId, key]);
      if (existing.rows[0]) return { ...existing.rows[0].payload, seq: existing.rows[0].seq };
    }
    if (terminalStatuses.includes(current.rows[0].status)) throw new ExecutionIdentityError('Cannot append an event to a terminal run.');
    const sequence = await client.query('UPDATE agent_runs SET last_event_seq=last_event_seq+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING last_event_seq', [tenantId, event.runId]);
    const seq = Number(sequence.rows[0]!.last_event_seq);
    await client.query('INSERT INTO run_events(run_id,tenant_id,seq,event_type,payload,event_key) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [event.runId, tenantId, seq, event.type, json(event), key]);
    if (event.type === 'approval.required' || event.type === 'question.required') {
      const kind = event.type === 'approval.required' ? 'approval' : 'question';
      const request = event.type === 'approval.required' ? event.actions : event.question;
      await client.query('INSERT INTO interrupts(id,tenant_id,run_id,kind,request) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(run_id,id) DO NOTHING', [event.interruptId, tenantId, event.runId, kind, json(request)]);
      await client.query('UPDATE agent_runs SET status=$3,execution_state=\'waiting\',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [tenantId, event.runId, kind === 'approval' ? 'waiting_approval' : 'waiting_question']);
    } else if (terminal) {
      const status = event.type === 'run.completed' ? 'completed' : event.type === 'run.cancelled' ? 'cancelled' : 'failed';
      await client.query('UPDATE agent_runs SET status=$3,execution_state=\'terminal\',finished_at=clock_timestamp(),error_code=$4,error_message=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [tenantId, event.runId, status, event.type === 'run.failed' ? event.code : null, event.type === 'run.failed' ? event.message : null]);
      await client.query('UPDATE interrupts SET status=\'cancelled\',resolved_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 AND status=\'pending\'', [tenantId, event.runId]);
    }
    return { ...event, seq } as PersistedAgentEvent;
  }

  async appendEvent(lease: RunExecutionLease, event: AgentEvent): Promise<PersistedAgentEvent> {
    if (event.runId !== lease.runId) throw new ExecutionIdentityError('Event run identity does not match the execution lease.');
    return this.withLease(lease, (client) => this.insertEvent(client, lease.tenantId, event));
  }

  private async assertRunning(client: PoolClient, lease: RunExecutionLease): Promise<void> {
    const result = await client.query('SELECT status,execution_state,cancel_requested_at FROM agent_runs WHERE tenant_id=$1 AND id=$2', [lease.tenantId, lease.runId]);
    if (result.rows[0]?.status !== 'running' || result.rows[0]?.execution_state !== 'running' || result.rows[0]?.cancel_requested_at) {
      throw new ExecutionIdentityError('New execution intents require a running execution.');
    }
  }

  async beginTool(lease: RunExecutionLease, intent: { scopeId: string; toolCallId: string; toolName: string; inputHash: string; input: unknown; replayPolicy: 'safe' | 'unsafe' }): Promise<{ record: ToolExecutionRecord; fresh: boolean }> {
    if (![intent.scopeId, intent.toolCallId, intent.toolName, intent.inputHash].every((value) => typeof value === 'string' && value.trim().length > 0)) throw new ExecutionIdentityError('Tool execution requires stable scope, tool call, name, and input hash identities.');
    return this.withLease(lease, async (client) => {
      await this.assertRunning(client, lease);
      const existing = await client.query('SELECT *,input=$5::jsonb AS same_input FROM tool_executions WHERE tenant_id=$1 AND run_id=$2 AND scope_id=$3 AND tool_call_id=$4', [lease.tenantId, lease.runId, intent.scopeId, intent.toolCallId, json(intent.input)]);
      const row = existing.rows[0];
      if (row) {
        if (row.input_hash !== intent.inputHash || row.tool_name !== intent.toolName || !row.same_input) throw new ExecutionIdentityError('Tool call identity was reused with different input or tool name.');
        return { record: toolOf(row), fresh: false };
      }
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO tool_executions(execution_id,tenant_id,run_id,scope_id,tool_call_id,tool_name,input_hash,input,idempotency_key,replay_policy,lease_epoch)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
        [id, lease.tenantId, lease.runId, intent.scopeId, intent.toolCallId, intent.toolName, intent.inputHash, json(intent.input), `tool:${id}`, intent.replayPolicy, lease.epoch],
      );
      return { record: toolOf(inserted.rows[0]!), fresh: true };
    });
  }

  private async updateTool(lease: RunExecutionLease, id: string, status: ToolExecutionRecord['status'], result?: unknown): Promise<void> {
    await this.withLease(lease, async (client) => {
      if (status === 'started') await this.assertRunning(client, lease);
      const updated = await client.query(
        `UPDATE tool_executions SET status=CASE WHEN status='succeeded' THEN status ELSE $4 END,
         result=CASE WHEN status='succeeded' THEN result WHEN $4='succeeded' THEN $5::jsonb ELSE result END,
         retry_count=CASE WHEN status <> 'succeeded' AND $4='started' THEN retry_count+1 ELSE retry_count END,
         lease_epoch=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 AND execution_id=$3 RETURNING execution_id`,
        [lease.tenantId, lease.runId, id, status, status === 'succeeded' ? json(result) : null, lease.epoch],
      );
      if (!updated.rows[0]) throw new ExecutionIdentityError('Tool execution identity was not found in this run.');
    });
  }

  async completeTool(lease: RunExecutionLease, id: string, result: unknown): Promise<void> { await this.updateTool(lease, id, 'succeeded', result); }
  async retryTool(lease: RunExecutionLease, id: string): Promise<void> { await this.updateTool(lease, id, 'started'); }
  async markToolUncertain(lease: RunExecutionLease, id: string): Promise<void> { await this.updateTool(lease, id, 'uncertain'); }

  async ensureChild(lease: RunExecutionLease, parentToolCallId: string, input: unknown, background: boolean): Promise<ChildExecutionRecord> {
    if (!parentToolCallId.trim()) throw new ExecutionIdentityError('Child execution requires a stable parent tool call identity.');
    return this.withLease(lease, async (client) => {
      await this.assertRunning(client, lease);
      const existing = await client.query('SELECT *,input=$4::jsonb AS same_input FROM child_executions WHERE tenant_id=$1 AND root_run_id=$2 AND parent_tool_call_id=$3', [lease.tenantId, lease.runId, parentToolCallId, json(input)]);
      if (existing.rows[0]) {
        if (!existing.rows[0].same_input || existing.rows[0].background !== background) throw new ExecutionIdentityError('Child identity was reused with different input or background mode.');
        return childOf(existing.rows[0]);
      }
      const id = randomUUID();
      const result = await client.query('INSERT INTO child_executions(id,tenant_id,root_run_id,parent_tool_call_id,thread_id,input,background,lease_epoch) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *', [id, lease.tenantId, lease.runId, parentToolCallId, `child:${id}`, json(input), background, lease.epoch]);
      return childOf(result.rows[0]!);
    });
  }

  async getChild(lease: RunExecutionLease, id: string): Promise<ChildExecutionRecord | null> {
    return this.withLease(lease, async (client) => {
      const result = await client.query('SELECT * FROM child_executions WHERE tenant_id=$1 AND root_run_id=$2 AND id=$3', [lease.tenantId, lease.runId, id]);
      return result.rows[0] ? childOf(result.rows[0]) : null;
    });
  }

  async listBackgroundChildren(lease: RunExecutionLease): Promise<ChildExecutionRecord[]> {
    return this.withLease(lease, async (client) => {
      const result = await client.query('SELECT * FROM child_executions WHERE tenant_id=$1 AND root_run_id=$2 AND background ORDER BY created_at,id', [lease.tenantId, lease.runId]);
      return result.rows.map(childOf);
    });
  }

  async saveChild(lease: RunExecutionLease, id: string, patch: Partial<ChildExecutionRecord>): Promise<ChildExecutionRecord> {
    const columns: Record<string, string> = { status: 'status', attempt: 'attempt', feedback: 'feedback', attemptResult: 'attempt_result', summary: 'summary', review: 'review' };
    return this.withLease(lease, async (client) => {
      const current = await client.query('SELECT status FROM agent_runs WHERE tenant_id=$1 AND id=$2', [lease.tenantId, lease.runId]);
      if (terminalStatuses.includes(current.rows[0]?.status)) throw new ExecutionIdentityError('Cannot update child execution after its parent is terminal.');
      const values: unknown[] = [lease.tenantId, lease.runId, id, lease.epoch];
      const assignments = ['lease_epoch=$4', 'updated_at=clock_timestamp()'];
      for (const [key, value] of Object.entries(patch)) {
        if (!Object.hasOwn(columns, key) || value === undefined) throw new ExecutionIdentityError('Child patch cannot change execution identity or contain undefined values.');
        const encoded = key === 'review' || key === 'attemptResult';
        values.push(encoded ? json(value) : value);
        assignments.push(`${columns[key]}=$${values.length}${encoded ? '::jsonb' : ''}`);
      }
      const result = await client.query(`UPDATE child_executions SET ${assignments.join(',')} WHERE tenant_id=$1 AND root_run_id=$2 AND id=$3 RETURNING *`, values);
      if (!result.rows[0]) throw new ExecutionIdentityError('Child execution identity was not found in this run.');
      return childOf(result.rows[0]);
    });
  }
}
