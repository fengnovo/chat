import { renderProfile } from './profile-renderer.js';
import type { MemoryQuery, MemoryRecord } from './types.js';

export interface MemoryListPort {
  list(input: {
    tenantId: string;
    userId: string;
    assistantKey: string;
    scope: 'global' | `project:${string}`;
    projectId?: string | null;
    limit: number;
  }): Promise<MemoryRecord[]>;
}

export interface MemorySearchPort {
  search(input: MemoryQuery): Promise<MemoryRecord[]>;
}

export interface MemoryRetrieverPort extends MemoryListPort, MemorySearchPort {}

export interface MemoryRetrievalResult {
  records: MemoryRecord[];
  context: string;
}

export function createMemoryRetriever(
  ports: MemoryRetrieverPort,
  options: { defaultLimit?: number; defaultMaxChars?: number } = {},
) {
  return {
    async retrieve(input: MemoryQuery): Promise<MemoryRetrievalResult> {
      const limit = Math.min(Math.max(input.limit ?? options.defaultLimit ?? 8, 1), 30);
      const scopes: Array<{ scope: 'global' | `project:${string}`; projectId?: string }> = [
        { scope: 'global' },
      ];
      if (input.projectId) scopes.push({ scope: `project:${input.projectId}`, projectId: input.projectId });

      const listed = await Promise.all(
        scopes.map((scope) => ports.list({
          tenantId: input.tenantId,
          userId: input.userId,
          assistantKey: input.assistantKey,
          ...scope,
          limit,
        })),
      );

      let searched: MemoryRecord[] = [];
      try {
        searched = await ports.search({ ...input, limit });
      } catch {
        // Semantic recall is an optimization. Core profile memories remain available.
      }

      const unique = new Map<string, MemoryRecord>();
      for (const memory of [...listed.flat(), ...searched]) {
        if (memory.status === 'active') unique.set(memory.id, memory);
      }
      const records = [...unique.values()].slice(0, limit);
      return {
        records,
        context: records.length === 0
          ? ''
          : renderProfile(records, { maxChars: input.maxChars ?? options.defaultMaxChars ?? 8_000 }),
      };
    },
  };
}

