import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client';
import { uploadAttachment, validateFile } from '../src/attachments/upload';

test('attachment uploads implement single, instant and retried multipart with byte hashes and completion', async (t) => {
  for (const mode of ['single', 'instant', 'multipart'] as const)
    await t.test(mode, async () => {
      const bytes = new TextEncoder().encode('document');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const received: Buffer[] = [];
      const bodies: any[] = [];
      let failedOnce = false;
      let base = '';
      const attachment = {
        id: 'a',
        filename: 'note.pdf',
        kind: 'file',
        sizeBytes: bytes.length,
        contentType: 'application/pdf',
        url: '/content',
      };
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        if (request.url?.startsWith('/put')) {
          if (mode === 'multipart' && !failedOnce) {
            failedOnce = true;
            response.writeHead(503);
            response.end();
            return;
          }
          received.push(raw);
          response.writeHead(200, { ETag: `"part-${received.length}"` });
          response.end();
          return;
        }
        if (request.url?.endsWith('/complete')) {
          bodies.push(raw.length ? JSON.parse(raw.toString()) : {});
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ attachment }));
          return;
        }
        bodies.push(JSON.parse(raw.toString()));
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            mode,
            attachment,
            uploadUrl: `${base}/put`,
            partSize: 4,
            parts: [
              { number: 2, uploadUrl: `${base}/put2` },
              { number: 1, uploadUrl: `${base}/put1` },
            ],
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const api = new ApiClient();
        api.configure(base, 'test');
        const progress: string[] = [];
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'throwIfAborted', {
          value: undefined,
        });
        const result = await uploadAttachment(
          api,
          {
            uri: '/local/note',
            name: 'note.pdf',
            size: bytes.length,
            mimeType: 'application/pdf',
          },
          {
            read: async () => bytes,
            hash: async (data) =>
              createHash('sha256').update(data).digest('hex'),
            put: fetch,
          },
          controller.signal,
          (value) => progress.push(value.phase),
        );
        assert.deepEqual(result, attachment);
        assert.equal(bodies[0].contentSha256, hash);
        assert.equal(bodies[0].storedSha256, hash);
        assert.equal(bodies[0].storedSizeBytes, bytes.length);
        assert.deepEqual(
          Buffer.concat(received),
          mode === 'instant' ? Buffer.alloc(0) : Buffer.from(bytes),
        );
        if (mode === 'multipart')
          assert.deepEqual(bodies[1].parts, [
            { number: 1, etag: '"part-1"' },
            { number: 2, etag: '"part-2"' },
          ]);
        assert.equal(progress.at(-1), 'verifying');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
});
test('file limits match Web/server classification including missing markdown MIME', () => {
  assert.throws(
    () => validateFile({ uri: 'x', name: 'note.md', size: 200_001 }),
    /200KB/,
  );
  assert.throws(
    () =>
      validateFile({
        uri: 'x',
        name: 'image.png',
        mimeType: 'image/png',
        size: 10 * 1024 * 1024 + 1,
      }),
    /10MB/,
  );
  assert.throws(
    () =>
      validateFile({ uri: 'x', name: 'doc.pdf', size: 50 * 1024 * 1024 + 1 }),
    /50MB/,
  );
});
