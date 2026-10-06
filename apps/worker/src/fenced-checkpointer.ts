import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { DurableExecutionError } from '@repo/agent-core';
import type { DurableExecutionRepository, Pool, PoolClient, RunExecutionLease } from '@repo/db';

/** PostgresSaver owns a transaction; adapt it to the already fenced outer transaction. */
function transactionPool(client: PoolClient): Pool {
  const query: PoolClient['query'] = ((...args: unknown[]) => {
    const statement = typeof args[0] === 'string' ? args[0].trim().toUpperCase() : '';
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) {
      return Promise.resolve({ rows: [], rowCount: 0, command: statement, oid: 0, fields: [] });
    }
    return (client.query as (...values: unknown[]) => unknown)(...args);
  }) as PoolClient['query'];
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

/** Row ownership validation and checkpoint write share one PostgreSQL transaction. */
export function createFencedCheckpointer(
  base: PostgresSaver,
  repository: DurableExecutionRepository,
  lease: RunExecutionLease,
): PostgresSaver {
  const fenced = Object.create(base) as PostgresSaver;
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (cause) { throw new DurableExecutionError(`Checkpoint storage interrupted: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  };
  fenced.getTuple = async (...args: Parameters<PostgresSaver['getTuple']>) => guarded(() => base.getTuple(...args));
  fenced.put = async (...args: Parameters<PostgresSaver['put']>) => guarded(() => repository.withLease(lease, async (client) => {
    const saver = new PostgresSaver(transactionPool(client), base.serde);
    // Both installed savers drop arbitrary runnable metadata unless explicitly supplied.
    args[2] = { ...args[0].metadata, ...args[2] };
    const result = await saver.put(...args);
    if (args[0].configurable?.thread_id === lease.input.sessionId && !args[0].configurable?.checkpoint_ns) {
      await client.query('UPDATE agent_runs SET checkpoint_id=$3 WHERE tenant_id=$1 AND id=$2',
        [lease.tenantId, lease.runId, args[1].id]);
    }
    return result;
  }));
  fenced.putWrites = async (...args: Parameters<PostgresSaver['putWrites']>) => guarded(() => repository.withLease(lease, async (client) => {
    await new PostgresSaver(transactionPool(client), base.serde).putWrites(...args);
  }));
  // The shared pool is owned by worker startup, not the per-execution adapter.
  fenced.end = async () => {};
  return fenced;
}
