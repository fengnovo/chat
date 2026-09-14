import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertDocumentBytes(bytes: Uint8Array, expectedHash: string, expectedSize: number, mime: string): void {
  if (bytes.byteLength !== expectedSize) throw new Error('Document size mismatch');
  if (sha256Hex(bytes).toLowerCase() !== expectedHash.toLowerCase()) throw new Error('Document hash mismatch');
}

