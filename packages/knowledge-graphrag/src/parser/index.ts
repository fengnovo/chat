import type { DocumentMime, ParsedDocument } from '../types.js';
import { parseTextDocument } from './text.js';
import { parsePdfDocument } from './pdf.js';
import { parseDocxDocument } from './docx.js';
import { parseXlsxDocument } from './xlsx.js';

/**
 * 支持的文档 MIME 白名单。
 * 旧版 .doc / .xls 不在支持范围（纯 JS 解析不可靠），上传时会被拒绝。
 */
export const SUPPORTED_MIMES: readonly DocumentMime[] = [
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export function isSupportedMime(mime: string): mime is DocumentMime {
  return (SUPPORTED_MIMES as readonly string[]).includes(mime);
}

/**
 * 按 MIME 类型分流解析。二进制格式（PDF/DOCX/XLSX）返回 Promise，
 * 文本格式同步返回；统一包装为 Promise 供 pipeline 调用。
 */
export async function parseDocument(bytes: Uint8Array, mime: DocumentMime): Promise<ParsedDocument> {
  switch (mime) {
    case 'text/plain':
    case 'text/markdown':
      return parseTextDocument(bytes, mime);
    case 'application/pdf':
      return parsePdfDocument(bytes);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return parseDocxDocument(bytes);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return parseXlsxDocument(bytes);
    default:
      throw new Error(`Unsupported MIME type: ${mime}`);
  }
}
