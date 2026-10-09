import type { PersistedAgentEvent } from '@repo/contracts';
import { runEventsChannel } from '@repo/contracts';
import { redactTelemetryValue } from '@repo/observability';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiServices } from './types.js';
import { createSseWriter } from './sse-writer.js';

type UiChunk = Record<string, unknown>;

function createChunkEncoder(runId: string) {
  const messageId = `message-${runId}`;
  let textId = `text-${runId}`;
  let started = false;
  let textStarted = false;
  let finished = false;
  return (events: PersistedAgentEvent[]): UiChunk[] => {
    if (events.length === 0 || finished) return [];
    const chunks: UiChunk[] = [];
    if (!started) {
      chunks.push({ type: 'start', messageId, messageMetadata: { runId } });
      started = true;
    }
    for (const event of events) {
      if (event.type === 'assistant.snapshot') {
        if (textStarted) chunks.push({ type: 'text-end', id: textId });
        textStarted = false;
        textId = `text-${runId}-${event.seq}`;
        chunks.push({ type: 'data-text-recovery', data: { text: event.text }, transient: false });
        continue;
      }
      if (event.type === 'assistant.delta') {
        if (!textStarted) {
          chunks.push({ type: 'text-start', id: textId });
          textStarted = true;
        }
        chunks.push({ type: 'text-delta', id: textId, delta: event.text });
        continue;
      }
      let agentData: PersistedAgentEvent = event;
      if (event.type === 'retrieval.completed') {
        // 保留过程 trace，同时持久化可审计的引用部分。
        chunks.push({
          type: 'data-citations',
          data: {
            ...event,
            citations: event.citations.map((citation) => {
              const { chunkId, kbId, documentId, documentName, ordinal, heading, score, via, images } = citation;
              return {
                chunkId,
                ...(kbId ? { kbId } : {}),
                documentId,
                documentName,
                ordinal,
                ...(heading ? { heading } : {}),
                score,
                via,
                ...(Array.isArray(images) && images.length ? { images } : {}),
              };
            }),
          },
          transient: false,
        });
        const { citations: _citations, ...traceEvent } = event;
        agentData = traceEvent as PersistedAgentEvent;
      }
      if (
        event.type === 'subagent.started' ||
        event.type === 'subagent.completed' ||
        event.type === 'subagent.reviewed'
      ) {
        // 子 Agent 事件：持久化为 data-subagent part（刷新后可从消息 parts 恢复卡片），
        // 同时下方 data-agent 过程流照常保留，供执行面板实时追踪。
        chunks.push({ type: 'data-subagent', data: event, transient: false });
      }
      chunks.push({ type: 'data-agent', data: agentData, transient: true });
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
  };
}

function chunksFrom(runId: string, events: PersistedAgentEvent[]): UiChunk[] {
  return createChunkEncoder(runId)(events);
}

function frame(chunk: UiChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 合并并发调用：任务进行中收到的调用会被记为「待再跑一次」，而不是丢弃。
 * SSE 推送必须这样处理——最后一次通知（run.completed）若恰好撞上进行中的
 * flush 而被丢掉，finish 永远不会发出，前端会停在「正在执行」，
 * 并且任务计划停留在中间快照。
 *
 * @param task 返回 true 表示已经完成，无需再跑。
 */
function createCoalescedRunner(
  task: () => Promise<boolean>,
): () => Promise<void> {
  let running = false;
  let pending = false;
  return async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        // eslint-disable-next-line no-await-in-loop -- 串行重跑，避免并发写同一响应
        const finished = await task();
        if (finished) return;
      } while (pending);
    } finally {
      running = false;
    }
  };
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

  // 统计稳定的重放前缀，但不将其保留在内存中。第二次分页读取会沿用现有的
  // 分块索引续传协议，并流式输出正文。
  const countChunks = createChunkEncoder(runId);
  let initialChunkCount = 0;
  let initialCursor = 0;
  const replayEnd = Number.isSafeInteger(run.lastEventSeq) ? run.lastEventSeq : undefined;
  let firstPage: PersistedAgentEvent[] | undefined;
  for (;;) {
    const events = await services.repository.listEvents(request.auth, runId, initialCursor, 500);
    firstPage ??= events;
    const prefix = replayEnd === undefined ? events : events.filter((event) => event.seq <= replayEnd);
    initialChunkCount += countChunks(prefix).length;
    if (prefix.length) initialCursor = prefix.at(-1)!.seq;
    if ((replayEnd !== undefined && (initialCursor >= replayEnd || events.some((event) => event.seq > replayEnd))) || events.length < 500 || prefix.some((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))) break;
  }
  const encodeEvents = createChunkEncoder(runId);
  const startChunk = requestedStart(request, initialChunkCount);
  let chunkCursor = 0;
  let eventCursor = 0;
  let closed = false;
  const writer = createSseWriter(reply.raw);
  const telemetry = services.observability?.startSse('chat');
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
    request.log.warn({ error: redactTelemetryValue(error) }, 'workflow SSE stream failed');
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
    'x-workflow-run-id': runId,
    'x-workflow-stream-tail-index': String(Math.max(initialChunkCount - 1, 0)),
    'x-vercel-ai-ui-message-stream': 'v1',
    'x-request-id': request.id,
  });
  reply.raw.flushHeaders();

  // flush 期间到达的通知必须排队重跑，不能直接丢弃：
  // 最后一次通知（通常是 run.completed）若被丢掉，finish 永远不会发出，
  // 前端就会停在「正在执行」并且任务计划停在中间状态。
  const flush = createCoalescedRunner(async () => {
    // 已经收尾：后续通知直接视为完成，避免重复 end()。
    if (closed) return true;
    let terminal = false;
    for (;;) {
      const cached = firstPage !== undefined;
      const events = firstPage ?? await services.repository.listEvents(request.auth, runId, eventCursor, 500);
      firstPage = undefined;
      if (closed) return true;
      if (events.length) eventCursor = events.at(-1)!.seq;
      const chunks = encodeEvents(events);
      for (const chunk of chunks) {
        if (chunkCursor++ < startChunk) continue;
        telemetry?.firstByte();
        if (!await writer.write(frame(chunk))) return true;
      }
      if (chunks.some((chunk) => chunk.type === 'finish')) {
        finish('server');
        return true;
      }
      // 统计前缀时，通知可能早于订阅到达。重放缓存的第一页后始终补读，
      // 即使该页为空也一样。
      if (cached) continue;
      if (events.length >= 500) continue;
      if (terminal) { finish('server'); return true; }
      const latest = await services.repository.getRun(request.auth, runId);
      terminal = !!latest && ['completed', 'failed', 'cancelled'].includes(latest.status);
      if (!terminal) {
        if (!events.length) await writer.write(': heartbeat\n\n');
        return false;
      }
      // 观察到终态后再读取一次，覆盖并发发生的最后一次提交。
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

export { chunksFrom, createChunkEncoder, createCoalescedRunner };
