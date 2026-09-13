import type { PersistedAgentEvent } from '@repo/contracts';
import { runEventsChannel } from '@repo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiServices } from './types.js';

function parseCursor(request: FastifyRequest): number {
  const query = request.query as { cursor?: string; startIndex?: string };
  const header = request.headers['last-event-id'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const raw = query.cursor ?? query.startIndex ?? headerValue?.split(':').at(-1) ?? '0';
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function sseFrame(event: PersistedAgentEvent): string {
  return `id: ${event.runId}:${event.seq}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function streamAgentEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApiServices,
  runId: string,
) {
  const run = await services.repository.getRun(request.auth, runId);
  if (!run) return reply.code(404).send({ error: 'run_not_found' });

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-agent-run-id': runId,
  });
  reply.raw.flushHeaders();

  let cursor = parseCursor(request);
  let flushing = false;
  let closed = false;

  const flush = async () => {
    if (flushing || closed) return;
    flushing = true;
    try {
      for (;;) {
        const events = await services.repository.listEvents(request.auth, runId, cursor);
        if (events.length === 0) break;
        for (const event of events) {
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          reply.raw.write(sseFrame(event));
        }
        if (events.length < 500) break;
      }
      const latest = await services.repository.getRun(request.auth, runId);
      if (latest && ['completed', 'failed', 'cancelled'].includes(latest.status)) {
        closed = true;
        reply.raw.end();
      }
    } finally {
      flushing = false;
    }
  };

  const unsubscribe = await services.streamSubscriptions.subscribe(
    runEventsChannel(runId),
    () => void flush(),
    (error: Error) => request.log.warn({ error }, 'SSE subscriber error'),
  );
  await flush();

  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': heartbeat\n\n');
  }, 15_000);

  request.raw.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
}
