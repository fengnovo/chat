import * as XLSX from 'xlsx';
import type { ParsedDocument } from '../types.js';

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * 从 XLSX 字节中提取所有工作表的文本。
 * 每个工作表输出：表名 + CSV 文本，多表之间用空行分隔。
 */
export function parseXlsxDocument(bytes: Uint8Array): ParsedDocument {
  const buffer = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    parts.push(`# ${sheetName}\n${csv}`);
  }
  return { text: parts.join('\n\n'), mime: MIME, sections: [], imageRefs: [] };
}
