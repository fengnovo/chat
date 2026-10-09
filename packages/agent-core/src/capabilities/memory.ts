import { tool } from '@langchain/core/tools';
import { CompositeBackend, StoreBackend, type StoreBackendOptions } from 'deepagents';
import { z } from 'zod';
import type { HeadlessAgentOptions } from '../types.js';

export interface LongTermMemoryBackendOptions {
  defaultBackend: unknown;
  store: unknown;
  namespace: string[];
}

export function buildLongTermMemoryBackend(options: LongTermMemoryBackendOptions) {
  return new CompositeBackend(options.defaultBackend as ConstructorParameters<typeof CompositeBackend>[0], {
    '/memories/': new StoreBackend({
      store: options.store as NonNullable<StoreBackendOptions['store']>,
      namespace: options.namespace,
    }),
  });
}

export async function writeLongTermMemoryProfile(
  store: unknown,
  namespace: string[],
  content: string,
): Promise<void> {
  const backend = new StoreBackend({ store: store as NonNullable<StoreBackendOptions['store']>, namespace });
  await backend.write('/profile.md', content);
}

export function createMemoryTools(memory: HeadlessAgentOptions['longTermMemory']) {
  const remember = memory?.remember;
  const forget = memory?.forget;
  const kinds = z.enum(['identity', 'preference', 'constraint', 'project_fact', 'episode', 'goal']);
  return [
    ...(remember ? [tool(
      async (input) => remember({ content: input.content, ...(input.kind ? { kind: input.kind } : {}), ...(input.normalizedKey ? { normalizedKey: input.normalizedKey } : {}) }),
      { name: 'remember_fact', description: '保存用户明确要求长期记住的事实。只保存非敏感、稳定信息。kind 取值：identity(身份/姓名/角色)、preference(偏好/喜欢)、constraint(约束/禁忌)、project_fact(项目事实/居住地)、episode(经历/事件)、goal(目标/计划)。', schema: z.object({ content: z.string().min(1).max(2000), kind: kinds.optional(), normalizedKey: z.string().max(100).optional() }) },
    )] : []),
    ...(forget ? [tool(
      async (input) => forget(input.memoryId),
      { name: 'forget_memory', description: '删除一条长期记忆。只有用户明确要求忘记时使用。', schema: z.object({ memoryId: z.string().uuid() }) },
    )] : []),
  ];
}
