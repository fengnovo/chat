import { DurableExecutionError, type HeadlessAgentOptions } from '@repo/agent-core';
import type { AgentRepository, RunExecutionLease } from '@repo/db';

/** 图中的所有副作用都使用同一个带栅栏的业务执行租约。 */
export function createDurableRuntimePorts(
  repository: AgentRepository,
  lease: RunExecutionLease,
  toolPolicies: Record<string, { replaySafe?: boolean | undefined; idempotencyKeyArgument?: string | undefined }>,
  runtimeResources: Record<string, string> = {},
): NonNullable<HeadlessAgentOptions['durable']> {
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (cause) { throw new DurableExecutionError('Durable execution storage interrupted', { cause }); }
  };
  return {
    legacyExecution: lease.legacyExecution === true,
    runtimeResources,
    bindRuntimeDescriptor: (descriptor) => guarded(() => repository.durable.bindExecutionDescriptor(lease, descriptor, 'agent')),
    assertOwnership: () => guarded(() => repository.durable.assertLease(lease)),
    ...(toolPolicies ? { toolPolicies: Object.fromEntries(Object.entries(toolPolicies).map(([name, policy]) => [name, {
      ...(policy.replaySafe !== undefined ? { replaySafe: policy.replaySafe } : {}),
      ...(policy.idempotencyKeyArgument !== undefined ? { idempotencyKeyArgument: policy.idempotencyKeyArgument } : {}),
    }])) } : {}),
    tools: {
      begin: (intent) => guarded(() => repository.durable.beginTool(lease, intent)),
      complete: (id, result) => guarded(() => repository.durable.completeTool(lease, id, result)),
      retry: (id) => guarded(() => repository.durable.retryTool(lease, id)),
      uncertain: (id) => guarded(() => repository.durable.markToolUncertain(lease, id)),
    },
    children: {
      ensure: (id, input, background) => guarded(() => repository.durable.ensureChild(lease, id, input, background)),
      get: (id) => guarded(() => repository.durable.getChild(lease, id)),
      listBackground: () => guarded(() => repository.durable.listBackgroundChildren(lease)),
      save: (id, patch) => guarded(() => repository.durable.saveChild(lease, id, patch)),
    },
  };
}
