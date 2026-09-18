import { isSensitiveMemory } from './policy.js';
import { memoryOperationSchema, type MemoryOperation } from './types.js';

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type MemoryModelInvoker = (input: {
  messages: MemoryMessage[];
  instruction: string;
}) => Promise<unknown>;

export async function extractMemoryOperations(
  messages: MemoryMessage[],
  invoke: MemoryModelInvoker,
): Promise<MemoryOperation[]> {
  const output = await invoke({
    messages,
    instruction: [
      'Extract only durable, user-confirmed facts useful in future conversations.',
      'Do not extract secrets, credentials, transient details, or assistant claims.',
      'Return a JSON array of memory operations with action, kind, content, normalizedKey, importance and confidence.',
    ].join(' '),
  });
  if (!Array.isArray(output)) return [];
  return output.flatMap((candidate) => {
    const parsed = memoryOperationSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.action === 'noop') return [];
    if (parsed.data.content && isSensitiveMemory(parsed.data.content)) return [];
    return [parsed.data];
  });
}

export interface ConsolidationContext {
  tenantId: string;
  userId: string;
  assistantKey: string;
  scope: string;
  projectId?: string | null;
  sourceRunId?: string | null;
  sourceSessionId?: string | null;
}

export interface ConsolidationPort {
  upsert(input: {
    tenantId: string;
    userId: string;
    assistantKey: string;
    scope: string;
    projectId?: string | null;
    kind: NonNullable<MemoryOperation['kind']>;
    content: string;
    normalizedKey: string;
    importance: number;
    confidence: number;
    sourceRunId?: string | null;
    sourceSessionId?: string | null;
  }): Promise<void>;
  remove(input: { tenantId: string; userId: string; id: string }): Promise<void>;
}

export async function consolidateMemoryOperations(
  context: ConsolidationContext,
  operations: readonly MemoryOperation[],
  port: ConsolidationPort,
): Promise<void> {
  for (const operation of operations) {
    if (operation.action === 'noop') continue;
    if (operation.action === 'delete') {
      if (operation.targetId) {
        await port.remove({ tenantId: context.tenantId, userId: context.userId, id: operation.targetId });
      }
      continue;
    }
    if (!operation.kind || !operation.content || !operation.normalizedKey) continue;
    if (isSensitiveMemory(operation.content)) continue;
    await port.upsert({
      ...context,
      kind: operation.kind,
      content: operation.content,
      normalizedKey: operation.normalizedKey,
      importance: operation.importance ?? 0.5,
      confidence: operation.confidence ?? 0.5,
    });
  }
}

