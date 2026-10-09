import type { PersistedAgentEvent } from '@repo/contracts';
import { runEventsChannel } from '@repo/contracts';
import { redactTelemetryValue } from '@repo/observability';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiServices } from './types.js';
import { createSseWriter } from './sse-writer.js';
import { createCoalescedRunner } from './chat-stream.js';

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

  const telemetry = services.observability?.startSse('events');
  let cursor = parseCursor(request);
  let closed = false;
  const writer = createSseWriter(reply.raw);
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const finish = (reason: 'client' | 'server' | 'error') => {
    if (closed) return;
    closed = true;
    writer.close();
    clearInterval(heartbeat);
    unsubscribe?.();
    telemetry?.finish(reason);
    if (reason !== 'client') reply.raw.end();
  };
  const fail = (error: unknown) => {
    request.log.warn({ error: redactTelemetryValue(error) }, 'SSE stream failed');
    finish('error');
  };
  reply.raw.once('close', () => finish('client'));
  reply.raw.once('error', fail);
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-agent-run-id': runId,
    'x-request-id': request.id,
  });
  reply.raw.flushHeaders();

  const flush = createCoalescedRunner(async () => {
    if (closed) return true;
      let terminal = false;
      for (;;) {
        const events = await services.repository.listEvents(request.auth, runId, cursor, 500);
        if (closed) return true;
        for (const event of events) {
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          telemetry?.firstByte();
          if (!await writer.write(sseFrame(event))) return true;
        }
        if (events.length >= 500) continue;
        if (terminal) {
          finish('server');
          return true;
        }
        const latest = await services.repository.getRun(request.auth, runId);
        terminal = !!latest && ['completed', 'failed', 'cancelled'].includes(latest.status);
        if (!terminal) {
          if (!events.length) await writer.write(': heartbeat\n\n');
          return false;
        }
        // 终态和最终事件会一起提交。观察到终态后再读取一次，
        // 确保并发发生在本次 flush 期间的完成事件也能送达。
      }
  });

  try {
    unsubscribe = await services.streamSubscriptions.subscribe(
      runEventsChannel(runId),
      () => void flush().catch(fail),
      fail,
    );
    if (closed) { unsubscribe(); return; }
    await flush();
    if (closed) return;
    heartbeat = setInterval(() => {
      if (!closed) void flush().catch(fail);
    }, 15_000);
  } catch (error) {
    fail(error);
  }
}
