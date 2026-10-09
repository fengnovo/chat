import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { DurableExecutionError } from '@repo/agent-core';
import type { DurableExecutionRepository, Pool, PoolClient, RunExecutionLease } from '@repo/db';

/** PostgresSaver 自行管理事务；将其适配到已有栅栏保护的外层事务中。 */
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

/** 行所有权校验与检查点写入共用同一个 PostgreSQL 事务。 */
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
    // 除非显式传入，否则两种已安装的 saver 都会丢弃任意 runnable 元数据。
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
  // 共享连接池由 Worker 启动流程持有，而不是由单次执行的适配器持有。
  fenced.end = async () => {};
  return fenced;
}
