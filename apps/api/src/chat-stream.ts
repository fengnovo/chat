import type { PersistedAgentEvent } from '@repo/contracts';
import { runEventsChannel } from '@repo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';

import type { ApiServices } from './types.js';

type UiChunk = Record<string, unknown>;

function chunksFrom(runId: string, events: PersistedAgentEvent[]): UiChunk[] {
  if (events.length === 0) return [];
  const messageId = `message-${runId}`;
  const textId = `text-${runId}`;
  const chunks: UiChunk[] = [
    {
      type: 'start',
      messageId,
      messageMetadata: { runId },
    },
  ];
  let textStarted = false;
  let finished = false;

  for (const event of events) {
    if (event.type === 'assistant.delta') {
      if (!textStarted) {
        chunks.push({ type: 'text-start', id: textId });
        textStarted = true;
      }
      chunks.push({ type: 'text-delta', id: textId, delta: event.text });
      continue;
    }
    chunks.push({ type: 'data-agent', data: event, transient: true });
    if (
      !finished &&
      ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)
    ) {
      if (textStarted) chunks.push({ type: 'text-end', id: textId });
      chunks.push({
        type: 'finish',
        finishReason: event.type === 'run.completed' ? 'stop' : 'error',
      });
      finished = true;
    }
  }
  return chunks;
}

function frame(chunk: UiChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function requestedStart(request: FastifyRequest, total: number): number {
  if (request.headers['x-page-resume'] === '1') return 0;
  const query = request.query as { startIndex?: string };
  const parsed = Number(query.startIndex ?? 0);
  if (!Number.isInteger(parsed)) return 0;
  return parsed < 0 ? Math.max(0, total + parsed) : Math.min(parsed, total);
}

export async function streamWorkflowRun(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApiServices,
  runId: string,
) {
  const run = await services.repository.getRun(request.auth, runId);
  if (!run) return reply.code(404).send({ error: 'run_not_found' });
  const subscriber = new Redis(services.config.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  await subscriber.connect();
  await subscriber.subscribe(runEventsChannel(runId));

  const initialEvents = await services.repository.listEvents(request.auth, runId, 0, 100_000);
  const initialChunks = chunksFrom(runId, initialEvents);
  let chunkCursor = requestedStart(request, initialChunks.length);
  let closed = false;
  let flushing = false;

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-workflow-run-id': runId,
    'x-workflow-stream-tail-index': String(Math.max(initialChunks.length - 1, 0)),
    'x-vercel-ai-ui-message-stream': 'v1',
  });
  reply.raw.flushHeaders();

  const flush = async () => {
    if (closed || flushing) return;
    flushing = true;
    try {
      const events = await services.repository.listEvents(request.auth, runId, 0, 100_000);
      const chunks = chunksFrom(runId, events);
      for (const chunk of chunks.slice(chunkCursor)) {
        reply.raw.write(frame(chunk));
        chunkCursor += 1;
      }
      if (chunks.some((chunk) => chunk.type === 'finish')) {
        closed = true;
        reply.raw.end();
      }
    } finally {
      flushing = false;
    }
  };

  subscriber.on('message', () => void flush());
  subscriber.on('error', (error: Error) =>
    request.log.warn({ error }, 'workflow SSE subscriber error'),
  );
  await flush();

  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': heartbeat\n\n');
  }, 15_000);
  request.raw.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    void subscriber.quit();
  });
}

export { chunksFrom };
