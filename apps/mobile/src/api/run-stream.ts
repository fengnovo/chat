import type { StreamAgentEvent } from './types';

export interface RunStreamCallbacks {
  /** 每条持久化事件（含 assistant.delta 等）。 */
  onEvent: (event: StreamAgentEvent) => void;
  /** run.completed / run.failed / run.cancelled 已收到，流正常收尾。 */
  onFinished: () => void;
  /** 网络中断后正在重连（第 N 次尝试）。 */
  onReconnecting?: (attempt: number) => void;
  /** 重连成功。 */
  onResumed?: () => void;
  onError?: (message: string) => void;
}

const TERMINAL_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 30;

/**
 * 解析 text/event-stream 增量文本。服务端帧格式：
 *   id: <runId>:<seq>\n event: agent\n data: {...}\n\n
 * 心跳为注释行「: heartbeat」，直接忽略。
 */
export class SseFrameParser {
  private buffer = '';

  /** 喂入增量文本，返回完整帧的 data 载荷。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];
    let boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
    while (boundary) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const payload = this.consumeFrame(frame);
      if (payload !== null) payloads.push(payload);
      boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
    }
    return payloads;
  }

  private consumeFrame(frame: string): string | null {
    let data = '';
    let hasData = false;
    for (const rawLine of frame.split(/\r\n|\n|\r/)) {
      if (rawLine.startsWith(':')) continue; // 注释 / 心跳
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      let value = colon === -1 ? '' : rawLine.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        data += (hasData ? '\n' : '') + value;
        hasData = true;
      }
    }
    return hasData ? data : null;
  }
}

export interface RunStreamHandle {
  /** 主动断开，不再重连。 */
  close: () => void;
}

/**
 * 订阅一次 run 的原生事件流（GET /api/agent/runs/:runId/events）。
 *
 * - 使用 expo/fetch（原生 URLSession / OkHttp 实现）读取流式响应体，
 *   不依赖 EventSource polyfill；
 * - 网络中断或服务端异常断开时，带 cursor=<seq> 查询参数重连，
 *   服务端从 PostgreSQL 按 seq 重放，不会丢事件也不会重跑 Agent；
 * - 收到终态事件（run.completed / failed / cancelled）后正常结束。
 */
export function createRunStream(
  streamingFetch: typeof fetch,
  baseUrl: string,
  token: string,
  runId: string,
  callbacks: RunStreamCallbacks,
  cursor = 0,
): RunStreamHandle {
  let closed = false;
  let attempt = 0;
  let controller = new AbortController();
  // 跨连接保存事件位点（seq 数值），重连时用 cursor=<seq> 查询参数续传。
  let lastSeq = cursor;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReconnect = () => {
    if (closed) return;
    attempt += 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      closed = true;
      callbacks.onError?.('连接恢复失败，请点击重新连接继续接收任务结果');
      return;
    }
    callbacks.onReconnecting?.(attempt);
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 5),
      RECONNECT_MAX_DELAY_MS,
    );
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!closed) void connect();
    }, delay);
  };

  const connect = async () => {
    const parser = new SseFrameParser();
    controller = new AbortController();
    const connection = controller;
    try {
      // 用查询参数 cursor=<seq> 做续传位点，比 Last-Event-ID 头部更可靠
      // （expo/fetch 在 iOS URLSession 下可能丢弃自定义头部）。
      const url =
        lastSeq > 0
          ? `${baseUrl}/api/agent/runs/${runId}/events?cursor=${lastSeq}`
          : `${baseUrl}/api/agent/runs/${runId}/events`;
      const response = await streamingFetch(url, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          ...(lastSeq > 0 ? { 'Last-Event-ID': `${runId}:${lastSeq}` } : {}),
        },
        signal: connection.signal,
      });
      if (closed) return;
      if (!response.ok || !response.body) {
        scheduleReconnect();
        return;
      }
      callbacks.onResumed?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (closed) return;
          if (done) break;
          for (const payload of parser.push(
            decoder.decode(value, { stream: true }),
          )) {
            if (closed) return;
            let event: StreamAgentEvent;
            try {
              event = JSON.parse(payload) as StreamAgentEvent;
            } catch {
              continue;
            }
            if (
              !event ||
              event.runId !== runId ||
              !Number.isInteger(event.seq) ||
              event.seq <= lastSeq
            )
              continue;
            callbacks.onEvent(event);
            lastSeq = event.seq;
            attempt = 0;
            if (TERMINAL_TYPES.has(event.type)) {
              closed = true;
              connection.abort();
              callbacks.onFinished();
              return;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      // 流在未收尾时结束：网络切换等场景，重连续传。
      scheduleReconnect();
    } catch {
      if (closed || connection.signal.aborted) return;
      scheduleReconnect();
    }
  };

  void connect();

  return {
    close: () => {
      closed = true;
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    },
  };
}
