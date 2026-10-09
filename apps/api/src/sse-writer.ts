import type { ServerResponse } from 'node:http';

/** One awaited frame at a time: a slow client never builds an unbounded send queue. */
export function createSseWriter(raw: ServerResponse, options: { drainTimeoutMs?: number; maxBufferedBytes?: number } = {}) {
  const timeoutMs = options.drainTimeoutMs ?? 10_000;
  const maxBytes = options.maxBufferedBytes ?? 2 * 1024 * 1024;
  let closed = false;
  let busy = false;
  let cancelWait: (() => void) | undefined;
  return {
    get busy() { return busy; },
    close() { closed = true; cancelWait?.(); },
    async write(frame: string): Promise<boolean> {
      if (closed) return false;
      if (busy) throw new Error('concurrent_sse_write');
      if (Buffer.byteLength(frame) + (raw.writableLength ?? 0) > maxBytes) throw new Error('sse_buffer_limit');
      busy = true;
      try {
        if (raw.write(frame) !== false) return true;
        return await new Promise<boolean>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            raw.off('drain', drain);
            raw.off('close', close);
            raw.off('error', error);
            cancelWait = undefined;
          };
          const drain = () => { cleanup(); resolve(true); };
          const close = () => { cleanup(); resolve(false); };
          const error = (cause: Error) => { cleanup(); reject(cause); };
          const timer = setTimeout(() => { cleanup(); reject(new Error('sse_drain_timeout')); }, timeoutMs);
          cancelWait = close;
          raw.once('drain', drain);
          raw.once('close', close);
          raw.once('error', error);
          if (closed || raw.destroyed) close();
        });
      } finally { busy = false; }
    },
  };
}
