import assert from 'node:assert/strict';
import test from 'node:test';

import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';

import {
  assistantTextOf,
  hasToolCallsOf,
  normalizeToolInput,
  normalizeToolOutput,
  usageOf,
} from '../src/index.js';

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

test('tool call arguments are parsed back from the JSON string the tools stream emits', () => {
  // tools 流的 input 是 JSON 字符串；不解析会退化成整串转义 JSON。
  assert.deepEqual(normalizeToolInput('{"command":"echo hi"}'), {
    command: 'echo hi',
  });
  assert.deepEqual(normalizeToolInput('{"file_path":"/a/b.js","content":"x"}'), {
    file_path: '/a/b.js',
    content: 'x',
  });
  // 非 JSON 入参保持原样。
  assert.equal(normalizeToolInput('plain text'), 'plain text');
  assert.equal(normalizeToolInput(null), null);
});

test('tool results keep only the printed content, not the serialized ToolMessage', () => {
  const serialized = {
    lc_serializable: true,
    lc_kwargs: { metadata: { versions: '[object Object]' } },
    content: 'hello_tool_args\n\n[Command succeeded with exit code 0]',
    tool_call_id: 'call_00_x',
  };
  assert.equal(
    normalizeToolOutput(serialized),
    'hello_tool_args\n\n[Command succeeded with exit code 0]',
  );
  assert.equal(normalizeToolOutput({ content: [{ type: 'text', text: 'hi' }] }), 'hi');
  // 普通字符串结果直接透传。
  assert.equal(normalizeToolOutput('ok'), 'ok');
});

test('oversized tool payloads are truncated before they reach the event table', () => {
  const long = 'x'.repeat(5_000);
  const parsed = normalizeToolInput(JSON.stringify({ command: long })) as {
    command: string;
  };
  assert.ok(parsed.command.length < long.length);
  assert.match(parsed.command, /\[已截断\]$/);
});

test('real token usage is read from the model metadata, never estimated', () => {
  // 形状与模型流最后一个 chunk 上的 usage_metadata 一致。
  const chunk = {
    content: 'hi',
    usage_metadata: {
      input_tokens: 9_010,
      output_tokens: 587,
      total_tokens: 9_597,
    },
  };
  assert.deepEqual(usageOf(chunk), {
    inputTokens: 9_010,
    outputTokens: 587,
    totalTokens: 9_597,
  });
  // 没有用量时应返回 null，交由调用方忽略，而不是用字符数估算充数。
  assert.equal(usageOf(new AIMessageChunk('hi')), null);
  assert.equal(usageOf(null), null);
});

test('usage falls back to the token sum when the total is missing', () => {
  const chunk = {
    content: 'hi',
    usage_metadata: { input_tokens: 120, output_tokens: 30 },
  };
  assert.deepEqual(usageOf(chunk), {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
  });
});

test('text from a tool-calling turn is narration, not the final answer', () => {
  // deepseek 会把过程旁白写进 content；带工具调用的轮次必须判为旁白，
  // 否则旁白会混进最终消息正文（表现为「思维链堆在上面、没有结果」）。
  assert.equal(
    hasToolCallsOf({ content: '网络之前是不通的，我再确认一次。', tool_calls: [{ name: 'execute' }] }),
    true,
  );
  assert.equal(
    hasToolCallsOf({ content: '正在读取文件', tool_call_chunks: [{ name: 'read_file' }] }),
    true,
  );
  assert.equal(
    hasToolCallsOf({
      content: '开始处理',
      additional_kwargs: { tool_calls: [{ name: 'grep' }] },
    }),
    true,
  );
  // 不带工具调用的轮次才是最终答复。
  assert.equal(hasToolCallsOf({ content: '已完成，结果如下。' }), false);
  assert.equal(hasToolCallsOf({ content: '你好', tool_calls: [] }), false);
  assert.equal(hasToolCallsOf(null), false);
});
