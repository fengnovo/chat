import * as pdfjsLib from 'pdfjs-dist';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ParsedDocument } from '../types.js';

// Node 环境：解析 pdfjs-dist worker 的真实文件路径
const require = createRequire(import.meta.url);
const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

/**
 * 从 PDF 字节中提取纯文本（逐页拼接）。
 * 使用官方维护的 pdfjs-dist，兼容性优于旧版 pdf-parse。
 */
export async function parsePdfDocument(bytes: Uint8Array): Promise<ParsedDocument> {
  const data = bytes instanceof Buffer ? new Uint8Array(bytes) : bytes;
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const parts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    parts.push(text);
  }
  return { text: parts.join('\n'), mime: 'application/pdf', sections: [] };
}
