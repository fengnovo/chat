import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentEventSchema,
  approvalDecisionSchema,
  createRunSchema,
  runJobSchema,
} from '../src/index.js';

test('validates a persisted coding agent event', () => {
  const result = agentEventSchema.parse({
    runId: '00000000-0000-4000-8000-000000000001',
    timestamp: new Date().toISOString(),
    type: 'assistant.delta',
    text: 'hello',
  });

  assert.equal(result.type, 'assistant.delta');
});

test('rejects empty runs and malformed jobs', () => {
  assert.equal(createRunSchema.safeParse({ message: '  ' }).success, false);
  assert.equal(runJobSchema.safeParse({ kind: 'start' }).success, false);
});

test('approval decisions default to one operation and allow session scope', () => {
  assert.equal(
    approvalDecisionSchema.parse({ decision: 'approve' }).scope,
    'once',
  );
  assert.equal(
    approvalDecisionSchema.parse({ decision: 'approve', scope: 'session' }).scope,
    'session',
  );
});

test('validates bounded retrieval completed events', () => {
  const event = {
    runId: '00000000-0000-4000-8000-000000000001',
    timestamp: new Date().toISOString(),
    type: 'retrieval.completed',
    retrievalId: '00000000-0000-4000-8000-000000000002',
    toolCallId: 'call-1',
    knowledgeBaseIds: ['00000000-0000-4000-8000-000000000003'],
    query: '负责 Atlas 的人是谁？',
    citations: [
      {
        chunkId: '00000000-0000-4000-8000-000000000004',
        documentId: '00000000-0000-4000-8000-000000000005',
        documentName: 'services.md',
        ordinal: 2,
        heading: '负责人',
        score: 0.91,
        via: 'both',
      },
    ],
    relations: [
      {
        source: 'Atlas 服务',
        relation: '负责人',
        target: '韩梅',
        chunkIds: ['00000000-0000-4000-8000-000000000004'],
      },
    ],
    stats: {
      vectorHits: 2,
      graphHops: 1,
      searchedKbs: 1,
      durationMs: 23,
      truncated: false,
    },
  };

  const result = agentEventSchema.parse(event);
  assert.equal(result.type, 'retrieval.completed');
});

test('rejects duplicate or oversized knowledge base selections', () => {
  const id = '00000000-0000-4000-8000-000000000003';
  assert.equal(
    createRunSchema.safeParse({ message: 'q', knowledgeBaseIds: [id, id] }).success,
    false,
  );
  assert.equal(
    createRunSchema.safeParse({
      message: 'q',
      knowledgeBaseIds: Array.from({ length: 11 }, (_, index) =>
        `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      ),
    }).success,
    false,
  );
});

test('requires knowledge base selections on every run job kind', () => {
  const common = {
    tenantId: '00000000-0000-4000-8000-000000000010',
    userId: '00000000-0000-4000-8000-000000000011',
    sessionId: '00000000-0000-4000-8000-000000000012',
    runId: '00000000-0000-4000-8000-000000000013',
    workspacePath: '/workspace',
    knowledgeBaseIds: [],
  };

  assert.equal(
    runJobSchema.safeParse({
      ...common,
      kind: 'start',
      message: 'q',
    }).success,
    true,
  );
  assert.equal(
    runJobSchema.safeParse({
      ...common,
      kind: 'resume-approval',
      decision: { decision: 'reject' },
    }).success,
    true,
  );
  assert.equal(
    runJobSchema.safeParse({
      ...common,
      kind: 'resume-question',
      answer: { selections: [] },
    }).success,
    true,
  );

  for (const job of [
    { ...common, kind: 'start', message: 'q' },
    { ...common, kind: 'resume-approval', decision: { decision: 'reject' } },
    { ...common, kind: 'resume-question', answer: { selections: [] } },
  ]) {
    const { knowledgeBaseIds: _knowledgeBaseIds, ...withoutSnapshot } = job;
    assert.equal(runJobSchema.safeParse(withoutSnapshot).success, false);
  }
});
