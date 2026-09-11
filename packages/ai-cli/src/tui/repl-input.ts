import type { ReplBuffer, ReplCursorView, ReplKey } from './types.js';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function previousBoundary(value: string, cursor: number): number {
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index >= cursor) break;
    previous = segment.index;
  }
  return previous;
}

function nextBoundary(value: string, cursor: number): number {
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index > cursor) return segment.index;
  }
  return value.length;
}

/** 把一次 Ink useInput 事件应用到支持完整 Unicode 字素的输入缓冲区。 */
export function editReplBuffer(
  current: ReplBuffer,
  input: string,
  key: ReplKey,
): ReplBuffer {
  const cursor = Math.max(0, Math.min(current.value.length, current.cursor));

  if (key.leftArrow) {
    return { ...current, cursor: previousBoundary(current.value, cursor) };
  }
  if (key.rightArrow) {
    return { ...current, cursor: nextBoundary(current.value, cursor) };
  }
  if (key.upArrow) {
    return { ...current, cursor: 0 };
  }
  if (key.downArrow) {
    return { ...current, cursor: current.value.length };
  }
  if (key.ctrl && input === 'd') {
    const end = nextBoundary(current.value, cursor);
    return {
      value: current.value.slice(0, cursor) + current.value.slice(end),
      cursor,
    };
  }
  if (key.backspace || key.delete || input === '\x7f' || input === '\b') {
    if (cursor === 0) return { ...current, cursor };
    const start = previousBoundary(current.value, cursor);
    return {
      value: current.value.slice(0, start) + current.value.slice(cursor),
      cursor: start,
    };
  }
  if (input && !key.ctrl && !key.meta && input >= ' ') {
    return {
      value: current.value.slice(0, cursor) + input + current.value.slice(cursor),
      cursor: cursor + input.length,
    };
  }

  return { ...current, cursor };
}

/** 将缓冲区拆成光标前、光标字素和光标后三段。 */
export function splitReplCursor(buffer: ReplBuffer): ReplCursorView {
  const cursor = Math.max(0, Math.min(buffer.value.length, buffer.cursor));
  const end = nextBoundary(buffer.value, cursor);
  return {
    before: buffer.value.slice(0, cursor),
    cursorText: buffer.value.slice(cursor, end) || ' ',
    after: buffer.value.slice(end),
  };
}
