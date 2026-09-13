import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextDocument } from '../src/index.js';

test('parses UTF-8 text and preserves markdown heading path', () => {
  const document = parseTextDocument(new TextEncoder().encode('# Guide\n## Setup\nHello'), 'text/markdown');
  assert.equal(document.text, '# Guide\n## Setup\nHello');
  assert.deepEqual(document.sections, [{ level: 1, title: 'Guide' }, { level: 2, title: 'Setup' }]);
});

test('rejects invalid UTF-8 and binary content', () => {
  assert.throws(() => parseTextDocument(new Uint8Array([0xc3, 0x28]), 'text/plain'), /UTF-8/);
  assert.throws(() => parseTextDocument(new Uint8Array([0, 1, 2]), 'text/plain'), /binary/);
});
