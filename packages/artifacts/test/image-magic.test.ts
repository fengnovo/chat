import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactVerificationError, assertImageMagic } from '../src/index.js';

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_HEAD = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF87A_HEAD = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const GIF89A_HEAD = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const WEBP_HEAD = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x10, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

// git-lfs pointer 的固定字节签名。它声明 mime 是 image/jpeg 但前 12 字节不是 JPEG 头。
const LFS_POINTER = Uint8Array.from([
  0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x20, 0x68, 0x74, 0x74, 0x70,
]);

test('accepts real PNG / JPEG / GIF / WEBP heads', () => {
  assert.doesNotThrow(() => assertImageMagic(PNG_HEAD, 'image/png'));
  assert.doesNotThrow(() => assertImageMagic(JPEG_HEAD, 'image/jpeg'));
  assert.doesNotThrow(() => assertImageMagic(JPEG_HEAD, 'image/jpg'));
  assert.doesNotThrow(() => assertImageMagic(GIF87A_HEAD, 'image/gif'));
  assert.doesNotThrow(() => assertImageMagic(GIF89A_HEAD, 'image/gif'));
  assert.doesNotThrow(() => assertImageMagic(WEBP_HEAD, 'image/webp'));
});

test('rejects LFS pointer bytes even when MIME is image/jpeg', () => {
  assert.throws(() => assertImageMagic(LFS_POINTER, 'image/jpeg'), (error) => {
    return error instanceof ArtifactVerificationError
      && /do not match declared MIME/.test(error.message);
  });
});

test('rejects declared MIME mismatch (PNG bytes but claim image/jpeg)', () => {
  assert.throws(() => assertImageMagic(PNG_HEAD, 'image/jpeg'), (error) => {
    return error instanceof ArtifactVerificationError
      && /do not match declared MIME/.test(error.message);
  });
});

test('rejects payloads shorter than the magic header length', () => {
  assert.throws(() => assertImageMagic(Uint8Array.from([0x89, 0x50]), 'image/png'), (error) => {
    return error instanceof ArtifactVerificationError && /too small to validate/.test(error.message);
  });
});

test('rejects unknown MIME', () => {
  assert.throws(() => assertImageMagic(PNG_HEAD, 'image/bmp'), (error) => {
    return error instanceof ArtifactVerificationError && /Unsupported image MIME/.test(error.message);
  });
});