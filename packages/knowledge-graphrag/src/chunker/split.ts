import { createHash } from 'node:crypto';
import type { ParsedDocument, TextChunk } from '../types.js';

export function stableChunkId(documentId: string, ordinal: number, text: string): string {
  const hash = createHash('sha256').update(`${documentId}\0${ordinal}\0${text}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40; hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 给定 chunk 的字符区间和文档的全部图片引用，挑选 offset 落在区间内的引用。
 * 这样检索时就能把"这张图出现在哪段正文里"挂回 chunk。
 */
function attachImageRefs(
  start: number,
  end: number,
  refs: ParsedDocument['imageRefs'],
): TextChunk['imageRefs'] {
  if (!refs.length) return [];
  const matched: TextChunk['imageRefs'] = [];
  for (const ref of refs) {
    if (ref.offset >= start && ref.offset < end) {
      matched.push({ path: ref.path, alt: ref.alt });
    }
  }
  return matched;
}

export function splitIntoChunks(document: ParsedDocument, options: { size: number; overlap: number }): TextChunk[] {
  if (!Number.isInteger(options.size) || options.size <= 0) throw new Error('size must be positive');
  if (!Number.isInteger(options.overlap) || options.overlap < 0 || options.overlap >= options.size) throw new Error('overlap must be less than size');
  const chunks: TextChunk[] = [];
  const headingRecords: Array<{ start: number; end: number; level: number; title: string }> = [];
  if (document.mime === 'text/markdown') {
    const lines = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lines.exec(document.text)) !== null) {
      const line = lineMatch[1]!;
      const offset = lineMatch.index;
      const end = offset + line.length;
      const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (headingMatch) headingRecords.push({ start: offset, end, level: headingMatch[1]!.length, title: headingMatch[2]! });
      if (lines.lastIndex === document.text.length) break;
    }
  }
  let start = 0;
  while (start < document.text.length) {
    const end = Math.min(start + options.size, document.text.length);
    const text = document.text.slice(start, end);
    const headings = headingRecords.filter((heading) => heading.end <= start || (heading.start >= start && heading.end <= end))
      .sort((a, b) => a.start - b.start).reduce((path, heading) => {
        path[heading.level - 1] = heading.title; return path.slice(0, heading.level);
      }, [] as string[]);
    chunks.push({
      ordinal: chunks.length,
      text,
      start,
      end,
      headingPath: headings,
      imageRefs: attachImageRefs(start, end, document.imageRefs ?? []),
    });
    if (end === document.text.length) break;
    start = end - options.overlap;
  }
  // 兜底：若文档完全没有 markdown 图片引用，别动 chunk；
  // 若 chunk 没拿到任何图片但文档里还有图（图片落在 split 边界），仍保留各 chunk 已挂上的内容。
  return chunks;
}