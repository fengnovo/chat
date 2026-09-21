import type { PersistedAgentEvent } from '@repo/contracts';
import { runEventsChannel } from '@repo/contracts';
import { redactTelemetryValue } from '@repo/observability';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
    let agentData: PersistedAgentEvent = event;
    if (event.type === 'retrieval.completed') {
      // Keep the process trace, while also persisting an auditable citation part.
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

  const initialEvents = await services.repository.listEvents(request.auth, runId, 0, 100_000);
  const initialChunks = chunksFrom(runId, initialEvents);
  let chunkCursor = requestedStart(request, initialChunks.length);
  let closed = false;
  const telemetry = services.observability?.startSse('chat');
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const finish = (reason: 'client' | 'server' | 'error') => {
    if (closed) return;
    closed = true;
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
    'x-workflow-stream-tail-index': String(Math.max(initialChunks.length - 1, 0)),
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
    const events = await services.repository.listEvents(request.auth, runId, 0, 100_000);
    if (closed) return true;
    const chunks = chunksFrom(runId, events);
    for (const chunk of chunks.slice(chunkCursor)) {
      telemetry?.firstByte();
      reply.raw.write(frame(chunk));
      chunkCursor += 1;
    }
    if (chunks.some((chunk) => chunk.type === 'finish')) {
      finish('server');
      return true;
    }
    return false;
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
      if (!closed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
  } catch (error) {
    fail(error);
  }
}

export { chunksFrom, createCoalescedRunner };
