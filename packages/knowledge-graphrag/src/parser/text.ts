import type { DocumentMime, ParsedDocument, ParsedImageRef, ParsedSection } from '../types.js';

/**
 * 把 markdown 图片引用中的 path 规范化：
 * 去除前导 "./" 与 "/"、压缩多余斜杠，方便后续用 basename 比对。
 */
function normalizeImagePath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

/** 仅扫描 http/https/data: 这类非本地图片引用，命中即返回 true。 */
function isExternalImage(path: string): boolean {
  return /^(https?:|data:)/i.test(path);
}

export function parseTextDocument(bytes: Uint8Array, mime: DocumentMime): ParsedDocument {
  if (mime !== 'text/plain' && mime !== 'text/markdown') throw new Error('Unsupported MIME type');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Invalid UTF-8 document'); }
  if (text.includes('\0')) throw new Error('binary content is not supported');
  const sections: ParsedSection[] = [];
  const imageRefs: ParsedImageRef[] = [];
  if (mime === 'text/markdown') {
    // 标题按行扫描；图片按全文扫描（图片可与正文同行）。
    for (const line of text.split(/\r?\n/)) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (match) sections.push({ level: match[1]!.length, title: match[2]! });
    }
    // ![alt](path "title") —— 允许可选的 title 部分；只关心 path 与 alt。
    const imagePattern = /!\[((?:[^\]\\]|\\.)*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
    let imageMatch: RegExpExecArray | null;
    while ((imageMatch = imagePattern.exec(text)) !== null) {
      const alt = imageMatch[1] ?? '';
      const rawPath = imageMatch[2] ?? '';
      if (!rawPath || isExternalImage(rawPath)) continue;
      imageRefs.push({ path: normalizeImagePath(rawPath), alt, offset: imageMatch.index });
    }
  }
  return { text, mime, sections, imageRefs };
}