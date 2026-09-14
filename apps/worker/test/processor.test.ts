import assert from 'node:assert/strict';
import test from 'node:test';
import { jwtVerify } from 'jose';

import { createKnowledgeRunToken } from '../src/processor.js';

const job = {
  kind: 'start' as const,
  tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333', runId: '44444444-4444-4444-8444-444444444444',
  message: 'search', workspacePath: '/workspace', knowledgeBaseIds: ['55555555-5555-4555-8555-555555555555'],
  attachments: [],
};

test('run token is signed from the immutable job knowledge base snapshot', async () => {
  const token = await createKnowledgeRunToken(job, 'secret');
  const { payload } = await jwtVerify(token, new TextEncoder().encode('secret'), { audience: 'knowledge-service' });
  assert.deepEqual(payload.kbIds, job.knowledgeBaseIds);
  assert.equal(payload.runId, job.runId);
});
