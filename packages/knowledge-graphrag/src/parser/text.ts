import type { ParsedDocument, ParsedSection } from '../types.js';

export function parseTextDocument(bytes: Uint8Array, mime: 'text/plain' | 'text/markdown'): ParsedDocument {
  if (mime !== 'text/plain' && mime !== 'text/markdown') throw new Error('Unsupported MIME type');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Invalid UTF-8 document'); }
  if (text.includes('\0')) throw new Error('binary content is not supported');
  const sections: ParsedSection[] = [];
  if (mime === 'text/markdown') {
    for (const line of text.split(/\r?\n/)) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (match) sections.push({ level: match[1]!.length, title: match[2]! });
    }
  }
  return { text, mime, sections };
}
