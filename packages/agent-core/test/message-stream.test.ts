import assert from 'node:assert/strict';
import test from 'node:test';

import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';

import {
  assistantTextOf,
  closeRemainingTodos,
  hasToolCallsOf,
  normalizeToolInput,
  normalizeToolOutput,
  summarizeCommandOutput,
  usageOf,
  extractRetrievalEvent,
} from '../src/index.js';

test('structured GraphRAG output becomes a bounded retrieval event', () => {
  const event = extractRetrievalEvent(
    '11111111-1111-4111-8111-111111111111',
    'call-1',
    'graphrag_search',
    { artifact: { structuredContent: {
      retrievalId: '22222222-2222-4222-8222-222222222222',
      knowledgeBaseIds: [], query: 'where', citations: [], relations: [],
      stats: { vectorHits: 0, graphHops: 0, searchedKbs: 0, durationMs: 1, truncated: false },
    } } },
  );
  assert.equal(event?.type, 'retrieval.completed');
  assert.equal(event?.toolCallId, 'call-1');
  assert.equal(extractRetrievalEvent('11111111-1111-4111-8111-111111111111', 'x', 'execute', { content: 'ok' }), null);
});

test('retrieval structured content is bounded', () => {
  const event = extractRetrievalEvent(
    '11111111-1111-4111-8111-111111111111', 'call-1', 'graphrag_search',
    { structuredContent: { retrievalId: '22222222-2222-4222-8222-222222222222', knowledgeBaseIds: [], query: 'q', citations: Array.from({ length: 30 }, () => ({ chunkId: '33333333-3333-4333-8333-333333333333', documentId: '44444444-4444-4444-8444-444444444444', documentName: 'd', ordinal: 0, score: 0, via: 'vector' })), relations: [], stats: { vectorHits: 30, graphHops: 0, searchedKbs: 0, durationMs: 1, truncated: false } } },
  );
  assert.ok(event);
  assert.equal(event?.type, 'retrieval.completed');
  if (event?.type === 'retrieval.completed') assert.ok(event.citations.length <= 20);
});

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

test('write_todos Command output is summarized, never dumped as [object Object]', () => {
  // 与 run_events 中实际落库的 write_todos tool.end 负载同构（LangGraph Command）。
  const command = {
    goto: [],
    graph: null,
    resume: null,
    update: {
      todos: [
        { status: 'completed', content: '任务一' },
        { status: 'in_progress', content: '任务二' },
        { status: 'pending', content: '任务三' },
      ],
      messages: [new ToolMessage({ content: 'Updated todo list', tool_call_id: 'c1' })],
    },
    lg_name: 'Command',
    lc_direct_tool_output: true,
  };
  const summary = summarizeCommandOutput(command);
  assert.ok(summary);
  assert.doesNotMatch(summary, /\[object /);
  assert.match(summary, /1 已完成/);
  assert.match(summary, /1 进行中/);
  assert.match(summary, /1 待开始/);

  // normalizeToolOutput 端到端：不得出现 [object Object] / [object ToolMessage]。
  const normalized = String(normalizeToolOutput(command));
  assert.doesNotMatch(normalized, /\[object (Object|ToolMessage)\]/);
  assert.equal(normalized, summary);
});

test('closeRemainingTodos closes only unfinished items on a clean finish', () => {
  const closed = closeRemainingTodos([
    { content: '已完成项', status: 'completed' },
    { content: '进行中项', status: 'in_progress' },
    { content: '待办项', status: 'pending' },
  ]);
  assert.deepEqual(closed, [
    { content: '已完成项', status: 'completed' },
    { content: '进行中项', status: 'completed' },
    { content: '待办项', status: 'completed' },
  ]);

  // 全部完成 / 空列表 / 脏数据：不补发。
  assert.equal(
    closeRemainingTodos([{ content: 'a', status: 'completed' }]),
    null,
  );
  assert.equal(closeRemainingTodos([]), null);
  assert.equal(closeRemainingTodos(null), null);
  assert.equal(closeRemainingTodos([{ foo: 1 }]), null);
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
