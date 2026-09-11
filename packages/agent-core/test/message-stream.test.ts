import assert from 'node:assert/strict';
import test from 'node:test';

import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';

import { assistantTextOf } from '../src/index.js';

test('only assistant messages are exposed as assistant text', () => {
  assert.equal(assistantTextOf(new AIMessageChunk('正在处理')), '正在处理');
  assert.equal(
    assistantTextOf(
      new ToolMessage({
        content: 'No files found',
        tool_call_id: 'tool-1',
      }),
    ),
    '',
  );
});
