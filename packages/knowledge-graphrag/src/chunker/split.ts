import { createHash } from 'node:crypto';
import type { ParsedDocument, TextChunk } from '../types.js';

export function stableChunkId(documentId: string, ordinal: number, text: string): string {
  const hash = createHash('sha256').update(`${documentId}\0${ordinal}\0${text}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40; hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function splitIntoChunks(document: ParsedDocument, options: { size: number; overlap: number }): TextChunk[] {
  if (!Number.isInteger(options.size) || options.size <= 0) throw new Error('size must be positive');
  if (!Number.isInteger(options.overlap) || options.overlap < 0 || options.overlap >= options.size) throw new Error('overlap must be less than size');
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < document.text.length) {
    const end = Math.min(start + options.size, document.text.length);
    const text = document.text.slice(start, end);
    const headings = document.mime === 'text/markdown' ? document.text.slice(0, start).split(/\r?\n/).reduce((path, line) => {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match) return path;
      const level = match[1]!.length; path[level - 1] = match[2]!; return path.slice(0, level);
    }, [] as string[]) : [];
    if (document.mime === 'text/markdown' && start === 0) {
      const first = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(document.text.split(/\r?\n/)[0] ?? '');
      if (first) headings.push(first[2]!);
    }
    chunks.push({ ordinal: chunks.length, text, headingPath: headings });
    if (end === document.text.length) break;
    start = end - options.overlap;
  }
  return chunks;
}
