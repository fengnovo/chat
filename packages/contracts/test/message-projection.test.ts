import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMessageEvent, emptyMessageProjection } from '../src/message-projection.js';
import type { AgentEvent } from '../src/index.js';

test('message projection replaces drafts with snapshots, preserves reasoning/citations and ignores duplicate sequences', () => {
  let projection = emptyMessageProjection();
  const append = (event: object) => { projection = applyMessageEvent(projection, { runId: 'run', timestamp: 'now', ...event } as AgentEvent & { seq?: number }); };
  append({ type: 'assistant.delta', text: 'draft', seq: 1 });
  append({ type: 'assistant.snapshot', text: 'answer', seq: 2 });
  append({ type: 'assistant.delta', text: '!', seq: 3 });
  append({ type: 'assistant.delta', text: '!', seq: 3 });
  append({ type: 'assistant.reasoning', text: 'reason', seq: 4 });
  const citation = { documentName: 'notes.md' };
  append({ type: 'retrieval.completed', citations: [citation], seq: 5 });
  append({ type: 'assistant.narration', text: 'process text', seq: 6 });
  assert.deepEqual(projection, { text: 'answer!', reasoning: 'reason', citations: [citation], lastSeq: 6 });
  append({ type: 'assistant.snapshot', text: '', seq: 7 });
  assert.equal(projection.text, '');
  assert.equal(projection.reasoning, 'reason');
});
