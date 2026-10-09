import type { AgentEvent } from '@repo/contracts';

type TextEvent = Extract<AgentEvent, { type: 'assistant.delta' | 'assistant.reasoning' | 'assistant.narration' }>;
function isText(event: AgentEvent): event is TextEvent {
  return ['assistant.delta', 'assistant.reasoning', 'assistant.narration'].includes(event.type);
}

/** Reduce per-token commits without delaying text beyond a short deadline. */
export async function* coalesceAgentEvents(source: AsyncIterable<AgentEvent>, options: { delayMs?: number; maxBytes?: number } = {}): AsyncGenerator<AgentEvent> {
  const delayMs = options.delayMs ?? 25;
  const maxBytes = options.maxBytes ?? 8 * 1024;
  const iterator = source[Symbol.asyncIterator]();
  const elapsed = Symbol('batch deadline');
  let pending: Promise<IteratorResult<AgentEvent>> | undefined;
  let buffer: TextEvent | undefined;
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: Promise<typeof elapsed> | undefined;
  const reset = () => { clearTimeout(timer); timer = undefined; deadline = undefined; buffer = undefined; bytes = 0; };
  try {
    for (;;) {
      pending ??= iterator.next();
      const next = buffer ? await Promise.race([pending, deadline!]) : await pending;
      if (next === elapsed) {
        const flushed = buffer!; reset(); yield flushed;
        continue; // Reuse the outstanding next(); never concurrently advance a source.
      }
      pending = undefined;
      if (next.done) {
        if (buffer) { const flushed = buffer; reset(); yield flushed; }
        return;
      }
      const event = next.value;
      const eventBytes = isText(event) ? Buffer.byteLength(event.text) : 0;
      if (buffer && (!isText(event) || buffer.type !== event.type || buffer.runId !== event.runId || bytes + eventBytes > maxBytes)) {
        const flushed = buffer; reset(); yield flushed;
      }
      if (!isText(event) || eventBytes >= maxBytes) { yield event; continue; }
      if (!buffer) {
        buffer = { ...event };
        bytes = eventBytes;
        deadline = new Promise<typeof elapsed>((resolve) => { timer = setTimeout(() => resolve(elapsed), delayMs); });
      } else { buffer.text += event.text; bytes += eventBytes; }
    }
  } catch (error) {
    if (buffer) { const flushed = buffer; reset(); yield flushed; }
    throw error;
  } finally {
    reset();
    // A source may be blocked on model IO. Its runtime owns cancellation; don't
    // delay the worker's abort/error handling by waiting for a prefetched next().
    void iterator.return?.().catch(() => {});
  }
}
