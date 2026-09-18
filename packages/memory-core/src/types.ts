import { z } from 'zod';

export const memoryKindSchema = z.enum([
  'identity',
  'preference',
  'constraint',
  'project_fact',
  'episode',
  'goal',
]);

export const memoryStatusSchema = z.enum(['active', 'superseded', 'deleted']);

export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryScope = 'global' | `project:${string}`;

export interface MemoryNamespaceInput {
  tenantId: string;
  userId: string;
  assistantKey: string;
  scope: MemoryScope;
}

export interface MemoryRecord {
  id: string;
  tenantId: string;
  userId: string;
  projectId?: string | null;
  assistantKey: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  normalizedKey: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  sourceSessionId?: string | null;
  sourceRunId?: string | null;
  supersedesId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export const memoryOperationSchema = z.object({
  action: z.enum(['insert', 'update', 'supersede', 'delete', 'noop']),
  kind: memoryKindSchema.optional(),
  content: z.string().trim().min(1).max(4_000).optional(),
  normalizedKey: z.string().trim().min(1).max(200).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  targetId: z.string().uuid().optional(),
  reason: z.string().trim().max(500).optional(),
});

export type MemoryOperation = z.infer<typeof memoryOperationSchema>;

export interface MemoryQuery {
  tenantId: string;
  userId: string;
  assistantKey: string;
  projectId?: string | null;
  query: string;
  limit?: number;
  maxChars?: number;
}

