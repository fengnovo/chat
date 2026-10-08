import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reducer,
  initialState,
  selectChatItems,
  type ChatState,
} from '../src/chat/state';
import type { StreamAgentEvent } from '../src/api/types';

function start(runId = 'r1') {
  return reducer(
    { ...initialState, loadingHistory: false },
    { type: 'run-started', runId, userText: '你好' },
  );
}
function event(
  state: ChatState,
  type: string,
  seq: number,
  fields: object = {},
  runId = 'r1',
) {
  return reducer(state, {
    type: 'event',
    event: { type, seq, runId, ...fields } as StreamAgentEvent,
  });
}

test('a streamed answer appears exactly once before and after completion', () => {
  let state = event(start(), 'assistant.delta', 1, { text: '唯一回答' });
  assert.equal(
    selectChatItems(state).filter((item) => item.text === '唯一回答').length,
    1,
  );
  state = event(state, 'run.completed', 2);
  assert.equal(
    selectChatItems(state).filter((item) => item.text === '唯一回答').length,
    1,
  );
});

test('replayed events never append duplicate text, reasoning or tools', () => {
  let state = event(start(), 'assistant.delta', 1, { text: '你好' });
  state = event(state, 'assistant.delta', 1, { text: '你好' });
  state = event(state, 'assistant.reasoning', 2, { text: '思考' });
  state = event(state, 'assistant.reasoning', 2, { text: '思考' });
  state = event(state, 'tool.started', 3, {
    invocationId: 't',
    tool: 'scrape',
    input: { url: 'https://example.com' },
  });
  state = event(state, 'tool.started', 3, {
    invocationId: 't',
    tool: 'scrape',
    input: { url: 'https://example.com' },
  });
  assert.equal(state.active?.assistantText, '你好');
  assert.equal(state.active?.reasoning, '思考');
  assert.equal(state.active?.activities.length, 1);
});

test('request failure preserves the pending question and partial answer', () => {
  let state = event(start(), 'assistant.delta', 1, { text: '请选择' });
  state = event(state, 'question.required', 2, {
    interruptId: 'q',
    question: {
      question: '水果',
      options: [{ label: '苹果' }],
      multiple: true,
      allowCustom: true,
    },
  });
  state = reducer(state, { type: 'send-failed', message: '网络错误' });
  assert.equal(state.active?.question?.interruptId, 'q');
  assert.equal(state.active?.assistantText, '请选择');
  assert.equal(state.active?.finished, false);
});

test('snapshot is canonical and completed turn retains its reasoning and tool output', () => {
  let state = event(start(), 'assistant.delta', 1, { text: '旧回答' });
  state = event(state, 'assistant.snapshot', 2, { text: '最终回答' });
  state = event(state, 'assistant.reasoning', 3, { text: '过程' });
  state = event(state, 'tool.completed', 4, {
    invocationId: 't',
    tool: 'scrape',
    output: 'Error calling tool scrape: timeout',
  });
  state = event(state, 'run.completed', 5);
  state = reducer(state, {
    type: 'run-started',
    runId: 'r2',
    userText: '继续',
  });
  const previous = selectChatItems(state).find(
    (item) => item.id === 'message-r1',
  );
  assert.equal(previous?.text, '最终回答');
  assert.equal(previous?.run?.reasoning, '过程');
  const tool = previous?.run?.activities[0];
  assert.equal(tool?.kind, 'tool');
  if (tool?.kind === 'tool') {
    assert.equal(tool.output, 'Error calling tool scrape: timeout');
    assert.equal(tool.failed, true);
  }
});

test('callbacks from an older run cannot complete or interrupt the new run', () => {
  let state = reducer(start(), {
    type: 'run-started',
    runId: 'r2',
    userText: '新任务',
  });
  state = event(
    state,
    'question.required',
    1,
    {
      interruptId: 'q2',
      question: {
        question: '新问题',
        options: [],
        multiple: false,
        allowCustom: true,
      },
    },
    'r2',
  );
  const before = state;
  state = reducer(state, { type: 'finished', runId: 'r1' });
  state = reducer(state, { type: 'reconnecting', runId: 'r1', attempt: 1 });
  state = reducer(state, {
    type: 'interrupt-responded',
    runId: 'r1',
    interruptId: 'q1',
  });
  state = reducer(state, {
    type: 'send-failed',
    runId: 'r1',
    message: '旧错误',
  });
  assert.equal(state, before);
  state = reducer(state, {
    type: 'interrupt-responded',
    runId: 'r2',
    interruptId: 'q1',
  });
  assert.equal(state, before);
});

test('a new question supersedes approval and terminal replay never reopens a finished run', () => {
  let state = event(start(), 'approval.required', 1, {
    interruptId: 'a',
    actions: [{ name: 'execute', summary: '测试' }],
  });
  state = event(state, 'question.required', 2, {
    interruptId: 'q',
    question: {
      question: '问题',
      options: [],
      multiple: false,
      allowCustom: true,
    },
  });
  assert.equal(state.active?.approval, null);
  state = event(state, 'run.completed', 3);
  const before = state;
  state = event(state, 'assistant.delta', 4, { text: '迟到消息' });
  assert.equal(state, before);
  assert.equal(
    selectChatItems(state).filter((item) => item.role === 'assistant').length,
    1,
  );
});

test('reopening a completed run restores one answer, task progress and tool results', () => {
  const snapshot = {
    session: { id: 's', title: '首条消息' },
    messages: [
      { id: 'user-r1', runId: 'r1', role: 'user', text: '首条消息' },
      { id: 'message-r1', runId: 'r1', role: 'assistant', text: '完成' },
    ],
    latestRun: { id: 'r1', status: 'completed' },
    latestRunEvents: [
      {
        runId: 'r1',
        seq: 1,
        type: 'todo.updated',
        todos: [{ content: '测试', status: 'completed' }],
      },
      {
        runId: 'r1',
        seq: 2,
        type: 'tool.completed',
        invocationId: 't',
        tool: 'read_file',
        output: '内容',
      },
      { runId: 'r1', seq: 3, type: 'assistant.snapshot', text: '完成' },
      { runId: 'r1', seq: 4, type: 'run.completed' },
    ],
  };
  const state = reducer(initialState, {
    type: 'history',
    items: [],
    activeRunId: null,
    snapshot,
  } as any);
  assert.equal(state.active?.finished, true);
  assert.equal(state.active?.todos[0]?.status, 'completed');
  assert.equal(state.active?.activities.length, 1);
  assert.equal(
    selectChatItems(state).filter((item) => item.text === '完成').length,
    1,
  );
});

test('foreground recovery rebuilds an unanswered question and resumes at its persisted cursor', () => {
  const state = reducer(initialState, {
    type: 'history',
    items: [],
    activeRunId: 'r1',
    snapshot: {
      session: { id: 's', title: '问题' },
      messages: [],
      latestRun: { id: 'r1', status: 'waiting_question' },
      latestRunEvents: [
        {
          runId: 'r1',
          seq: 7,
          type: 'question.required',
          interruptId: 'q',
          question: {
            question: '请选择',
            options: [{ label: 'A' }],
            multiple: true,
            allowCustom: true,
          },
        },
      ],
    },
  } as any);
  assert.equal(state.active?.question?.interruptId, 'q');
  assert.equal(state.active?.lastSeq, 7);
  assert.equal(state.active?.finished, false);
});

test('foreground recovery does not reopen an already answered interrupt', () => {
  const state = reducer(initialState, {
    type: 'history',
    items: [],
    activeRunId: 'r1',
    snapshot: {
      session: { id: 's', title: '问题' },
      messages: [],
      latestRun: { id: 'r1', status: 'running' },
      latestRunEvents: [
        {
          runId: 'r1',
          seq: 7,
          type: 'question.required',
          interruptId: 'q',
          question: {
            question: '请选择',
            options: [],
            multiple: false,
            allowCustom: true,
          },
        },
      ],
    },
  } as any);
  assert.equal(state.active?.question, null);
  assert.equal(state.active?.finished, false);
});

test('a delayed create response after foreground recovery never duplicates or resets the recovered turn', () => {
  let state = event(start(), 'assistant.delta', 1, { text: '后台结果' });
  const before = state;
  state = reducer(state, {
    type: 'run-started',
    runId: 'r1',
    userText: '你好',
  });
  assert.equal(state, before);
  assert.equal(state.active?.assistantText, '后台结果');
});
