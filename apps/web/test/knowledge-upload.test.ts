import assert from 'node:assert/strict';
import test from 'node:test';

import * as knowledgeApi from '../app/components/resilient-chat/api';
import { uploadKnowledgeDocument } from '../app/components/resilient-chat/api';

const checksum = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('uploads with the signed URL and headers before confirming the document', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (calls.length === 1) {
      return jsonResponse({
        document: { id: 'document-1', name: 'notes.md', status: 'pending' },
        upload: {
          uploadUrl: 'https://storage.example/signed-upload',
          headers: {
            'content-type': 'text/markdown',
            'x-amz-meta-sha256': checksum,
          },
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      }, 201);
    }
    if (calls.length === 2) return new Response(null, { status: 200 });
    return jsonResponse({ id: 'document-1', name: 'notes.md', status: 'queued' });
  };

  const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
  const document = await uploadKnowledgeDocument('kb-1', file);

  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.input, '/api/knowledge-bases/kb-1/documents/uploads');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    name: 'notes.md',
    mime: 'text/markdown',
    sizeBytes: 5,
    sha256: checksum,
  });

  assert.equal(calls[1]?.input, 'https://storage.example/signed-upload');
  assert.equal(calls[1]?.init?.method, 'PUT');
  assert.equal(calls[1]?.init?.body, file);
  const uploadHeaders = new Headers(calls[1]?.init?.headers);
  assert.equal(uploadHeaders.get('content-type'), 'text/markdown');
  assert.equal(uploadHeaders.get('x-amz-meta-sha256'), checksum);

  assert.equal(calls[2]?.input, '/api/knowledge-bases/kb-1/documents/document-1/confirm');
  assert.equal(calls[2]?.init?.method, 'POST');
  assert.deepEqual(document, { id: 'document-1', name: 'notes.md', status: 'queued' });
});

test('does not confirm when the signed upload fails', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        document: { id: 'document-2' },
        upload: {
          uploadUrl: 'https://storage.example/rejected-upload',
          headers: {
            'content-type': 'text/plain',
            'x-amz-meta-sha256': checksum,
          },
        },
      }, 201);
    }
    return new Response(null, { status: 403 });
  };

  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  await assert.rejects(
    uploadKnowledgeDocument('kb-1', file),
    /HTTP 403/,
  );
  assert.equal(calls, 2);
});

test('reports a failed confirmation after a successful signed upload', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        document: { id: 'document-3' },
        upload: {
          uploadUrl: 'https://storage.example/signed-upload',
          headers: {
            'content-type': 'text/markdown',
            'x-amz-meta-sha256': checksum,
          },
        },
      }, 201);
    }
    if (calls === 2) return new Response(null, { status: 200 });
    return jsonResponse({ error: 'document_verification_failed' }, 400);
  };

  const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
  await assert.rejects(
    uploadKnowledgeDocument('kb-1', file),
    /HTTP 400/,
  );
  assert.equal(calls, 3);
});

test('accepts legacy nested and flat signed-upload response shapes', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const variants = [
    [{
      document: { id: 'legacy-document' },
      upload: {
        url: 'https://storage.example/legacy-upload',
        headers: {
          'content-type': 'text/markdown',
          'x-amz-meta-sha256': checksum,
        },
      },
    }, 'https://storage.example/legacy-upload'],
    [{
      document: { id: 'flat-document' },
      uploadUrl: 'https://storage.example/flat-upload',
      headers: {
        'content-type': 'text/markdown',
        'x-amz-meta-sha256': checksum,
      },
    }, 'https://storage.example/flat-upload'],
  ] as const;

  for (const [variant, expectedUploadUrl] of variants) {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      if (calls.length === 1) return jsonResponse(variant, 201);
      if (calls.length === 2) return new Response(null, { status: 200 });
      return jsonResponse({ document: { ...variant.document, status: 'queued' } });
    };

    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    const document = await uploadKnowledgeDocument('kb-1', file);

    assert.equal(calls.length, 3);
    assert.equal(calls[1], expectedUploadUrl);
    assert.equal(document.status, 'queued');
  }
});

test('fetches the document list for a knowledge base', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return jsonResponse({
      data: [
        {
          id: 'document-1',
          name: 'notes.md',
          status: 'ready',
          size_bytes: '5',
          chunk_count: 2,
        },
      ],
    });
  };

  const fetchDocuments = (knowledgeApi as typeof knowledgeApi & {
    fetchKnowledgeDocuments?: (kbId: string) => Promise<unknown[]>;
  }).fetchKnowledgeDocuments;
  assert.equal(typeof fetchDocuments, 'function');

  const documents = await fetchDocuments?.('kb-1');
  assert.deepEqual(calls, ['/api/knowledge-bases/kb-1/documents']);
  assert.deepEqual(documents, [
    {
      id: 'document-1',
      name: 'notes.md',
      status: 'ready',
      size_bytes: '5',
      chunk_count: 2,
    },
  ]);
});

test('uses text/plain for txt files when the browser omits the MIME type', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (calls.length === 1) {
      return jsonResponse({
        document: { id: 'text-document' },
        upload: {
          uploadUrl: 'https://storage.example/text-upload',
          headers: {
            'content-type': 'text/plain',
            'x-amz-meta-sha256': checksum,
          },
        },
      }, 201);
    }
    if (calls.length === 2) return new Response(null, { status: 200 });
    return jsonResponse({ id: 'text-document', status: 'queued' });
  };

  await uploadKnowledgeDocument('kb-1', new File(['hello'], 'notes.txt'));

  assert.equal(JSON.parse(String(calls[0]?.init?.body)).mime, 'text/plain');
  assert.equal(new Headers(calls[1]?.init?.headers).get('content-type'), 'text/plain');
});
