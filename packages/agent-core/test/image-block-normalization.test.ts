import assert from 'node:assert/strict';
import test from 'node:test';

import { HumanMessage, ToolMessage, isToolMessage } from '@langchain/core/messages';

import { normalizeImageBlocksForOpenAI } from '../src/index.js';

test('converts LangChain standard image blocks to OpenAI image_url data URLs', () => {
  const tool = new ToolMessage({
    tool_call_id: 'call-1',
    content: [
      { type: 'text', text: 'reading png' },
      {
        type: 'image',
        source_type: 'base64',
        data: 'AAAA',
        mime_type: 'image/png',
      },
    ],
  });

  const result = normalizeImageBlocksForOpenAI([tool])![0]!;
  assert.ok(isToolMessage(result));
  assert.equal(result.tool_call_id, 'call-1');
  assert.ok(Array.isArray(result.content));
  const imageBlock = (result.content as unknown[])[1] as Record<string, unknown>;
  assert.equal(imageBlock.type, 'image_url');
  assert.deepEqual(imageBlock.image_url, { url: 'data:image/png;base64,AAAA' });
});

test('accepts raw MCP image block shape with mimeType', () => {
  const human = new HumanMessage({
    content: [{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }],
  });

  const result = normalizeImageBlocksForOpenAI([human])![0]!;
  const block = (result.content as unknown[])[0] as Record<string, unknown>;
  assert.equal(block.type, 'image_url');
  assert.deepEqual(block.image_url, { url: 'data:image/jpeg;base64,BBBB' });
});

test('leaves non-image and already-converted messages untouched (same reference)', () => {
  const messages = [
    new HumanMessage({ content: 'plain text' }),
    new HumanMessage({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    }),
    new HumanMessage({
      // 非 base64 来源的标准图片块没有 data，不做转换。
      content: [{ type: 'image', source_type: 'url', url: 'https://example.com/b.png' }],
    }),
  ];

  const result = normalizeImageBlocksForOpenAI(messages);
  assert.equal(result, messages);
});
