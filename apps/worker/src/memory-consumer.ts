import { randomUUID } from 'node:crypto';

import { createResilientModelRouter } from '@repo/agent-core';
import type { Job } from 'bullmq';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { AgentEvent } from '@repo/contracts';
import type { AgentRepository, MemoryJobRecord } from '@repo/db';
import {
  consolidateMemoryOperations,
  extractMemoryOperations,
  type MemoryMessage,
} from '@repo/memory-core';

type MemoryRepository = AgentRepository & {
  claimMemoryJob: (leaseMs?: number) => Promise<MemoryJobRecord | null>;
  completeMemoryJob: (id: string) => Promise<void>;
  failMemoryJob: (id: string, error: string, delayMs?: number) => Promise<void>;
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part === 'object' && part && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

function parseModelOutput(value: unknown): unknown {
  const raw = typeof value === 'string' ? value : textOf(value);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  try {
    return JSON.parse(fenced.trim());
  } catch {
    return [];
  }
}

export async function processMemoryJob(
  repository: MemoryRepository,
  job: MemoryJobRecord,
  model: { invoke: (messages: unknown[]) => Promise<unknown> },
  index?: { upsert: (memory: { id: string; tenantId: string; userId: string; content: string; normalizedKey: string; kind?: string; importance?: number; confidence?: number; projectId?: string | null; scope?: string }) => Promise<void> },
  metrics?: { memoryOperation?: (measurement: { operation: 'extract' | 'upsert'; outcome: 'success' | 'failure'; durationMs: number }) => void },
): Promise<void> {
  const tracer = trace.getTracer('agent-memory');
  return tracer.startActiveSpan('memory.extract', { attributes: { 'gen_ai.operation.name': 'memory.extract', 'memory.run_id': job.runId } }, async (span) => {
  try {
  const run = await repository.getRunForWorker(job.tenantId, job.runId);
  if (!run || run.status !== 'completed') {
    await repository.completeMemoryJob(job.id);
    return;
  }
  const events = await repository.listEventsForWorker(job.tenantId, job.runId);
  const session = await repository.getSessionForWorker(job.tenantId, job.sessionId).catch(() => null);
  const projectId = session?.projectId ?? null;
  const assistant = events
    .filter((event: AgentEvent) => event.type === 'assistant.delta' || event.type === 'assistant.narration')
    .map((event: AgentEvent) => 'text' in event ? event.text : '')
    .join('');
  const messages: MemoryMessage[] = [
    { role: 'user', content: run.userMessage },
    ...(assistant ? [{ role: 'assistant' as const, content: assistant }] : []),
  ];
  const extractStartedAt = Date.now();
  const operations = await extractMemoryOperations(messages, async ({ messages: input, instruction }) => {
    const response = await model.invoke([
      { role: 'system', content: `${instruction} Return JSON only. The user's latest message has priority over stored facts.` },
      ...input,
    ]);
    return parseModelOutput(response && typeof response === 'object' && 'content' in response
      ? (response as { content: unknown }).content
      : response);
  });
  metrics?.memoryOperation?.({ operation: 'extract', outcome: 'success', durationMs: Date.now() - extractStartedAt });
  await consolidateMemoryOperations(
    {
      tenantId: job.tenantId,
      userId: job.userId,
      assistantKey: 'chat',
      scope: projectId ? `project:${projectId}` : 'global',
      projectId,
      sourceRunId: job.runId,
      sourceSessionId: job.sessionId,
    },
    operations,
    {
      upsert: async (input) => {
        const upsertStartedAt = Date.now();
        const saved = await repository.upsertMemory({
          ...input,
          id: randomUUID(),
          sourceSessionId: input.sourceSessionId ?? null,
          sourceRunId: input.sourceRunId ?? null,
          supersedesId: null,
          projectId,
          scope: projectId ? `project:${projectId}` as `project:${string}` : 'global' as const,
          status: 'active',
          metadata: { extractor: 'memory-consumer-v1' },
        });
        await index?.upsert({
          id: saved.id,
          tenantId: saved.tenantId,
          userId: saved.userId,
          content: saved.content,
          normalizedKey: saved.normalizedKey,
          kind: saved.kind,
          importance: saved.importance,
          confidence: saved.confidence,
          projectId: saved.projectId,
          scope: saved.scope,
        }).catch(() => undefined);
        metrics?.memoryOperation?.({ operation: 'upsert', outcome: 'success', durationMs: Date.now() - upsertStartedAt });
      },
      remove: (input) => repository.deleteMemory(input.tenantId, input.userId, input.id),
    },
  );
  await repository.completeMemoryJob(job.id);
  span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally { span.end(); }
  });
}

export function startMemoryConsumer(options: {
  repository: MemoryRepository;
  models: Parameters<typeof createResilientModelRouter>[0]['models'];
  index?: { upsert: (memory: { id: string; tenantId: string; userId: string; content: string; normalizedKey: string; kind?: string; importance?: number; confidence?: number; projectId?: string | null; scope?: string }) => Promise<void> };
  metrics?: { memoryOperation?: (measurement: { operation: 'extract' | 'upsert'; outcome: 'success' | 'failure'; durationMs: number }) => void };
  intervalMs?: number;
  logger?: { error: (message: string, error?: unknown) => void };
}) {
  let stopped = false;
  let running = false;
  let modelPromise: Promise<{ primary: { invoke: (...args: any[]) => Promise<any> } }> | undefined;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    let claimed: MemoryJobRecord | null = null;
    try {
      const job = await options.repository.claimMemoryJob();
      if (!job) return;
      claimed = job;
      modelPromise ??= createResilientModelRouter({ models: options.models }) as Promise<{ primary: { invoke: (...args: any[]) => Promise<any> } }>;
      const model = (await modelPromise).primary;
      await processMemoryJob(options.repository, job, model, options.index, options.metrics);
    } catch (error) {
      if (claimed) await options.repository.failMemoryJob(claimed.id, error instanceof Error ? error.message : String(error));
      options.logger?.error('memory job failed', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 2_000);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function createMemoryQueueProcessor(options: Parameters<typeof startMemoryConsumer>[0]) {
  let modelPromise: Promise<{ primary: { invoke: (...args: any[]) => Promise<any> } }> | undefined;
  return async (_job: Job) => {
    const claimed = await options.repository.claimMemoryJob();
    if (!claimed) return;
    modelPromise ??= createResilientModelRouter({ models: options.models }) as Promise<{ primary: { invoke: (...args: any[]) => Promise<any> } }>;
    try {
      await processMemoryJob(options.repository, claimed, (await modelPromise).primary, options.index, options.metrics);
    } catch (error) {
      await options.repository.failMemoryJob(claimed.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}
