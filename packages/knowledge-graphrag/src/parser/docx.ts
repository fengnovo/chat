import mammoth from 'mammoth';
import type { ParsedDocument } from '../types.js';

/**
 * 从 DOCX 字节中提取纯文本。
 * mammoth.extractRawText 只保留文本内容，丢弃样式与图片。
 */
export async function parseDocxDocument(bytes: Uint8Array): Promise<ParsedDocument> {
  const buffer = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  const result = await mammoth.extractRawText({ buffer });
  const text = typeof result?.value === 'string' ? result.value : '';
  return { text, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sections: [], imageRefs: [] };
}
