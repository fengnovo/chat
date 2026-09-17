import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendReviewGap,
  clampSubagentText,
  createBackgroundRunContext,
  createSpawnSubagentTool,
  extractSubagentResult,
  extractSubagentSummary,
  filterSubagentTools,
  isBlockedSubagentTool,
  reviewSubagentOutput,
  reviewVerdictSchema,
  runSpawnLoop,
  spawnSubagentSchema,
  type ReviewOutcome,
  type SpawnLoopDeps,
  type SpawnSubagentInput,
  type SpawnSubagentOptions,
  type SubagentRunStatus,
} from '../src/subagent.js';
import type { AgentEvent } from '@repo/contracts';

test('blocked tools cover spawn/ask_user and name-pattern bypasses', () => {
  assert.equal(isBlockedSubagentTool('spawn_subagent'), true);
  assert.equal(isBlockedSubagentTool('ask_user'), true);
  assert.equal(isBlockedSubagentTool('subagent_helper'), true);
  assert.equal(isBlockedSubagentTool('SpawnTask'), true);
  assert.equal(isBlockedSubagentTool('graphrag_search'), false);
  assert.equal(isBlockedSubagentTool('read_file'), false);
});

test('filterSubagentTools strips dispatch tools, then narrows by allowlist', () => {
  const tools = [
    { name: 'read_file' },
    { name: 'spawn_subagent' },
    { name: 'ask_user' },
    { name: 'graphrag_search' },
  ];
  // 未提供 allowlist：默认继承全集减去被禁工具（防递归）。
  assert.deepEqual(
    filterSubagentTools(tools).map((tool) => tool.name),
    ['read_file', 'graphrag_search'],
  );
  // allowlist 是建议清单：先过滤再收敛，被禁工具即使被点名也会被剔除。
  assert.deepEqual(
    filterSubagentTools(tools, ['read_file', 'spawn_subagent']).map((tool) => tool.name),
    ['read_file'],
  );
  // allowlist 没有任何命中时，子 Agent 拿不到任何工具（以过滤结果为准）。
  assert.deepEqual(filterSubagentTools(tools, ['nonexistent']), []);
});

test('clampSubagentText keeps the result within the limit', () => {
  const text = 'a'.repeat(2_500);
  const clamped = clampSubagentText(text, 2_000);
  assert.equal(clamped.length, 2_000);
  assert.equal(clamped.endsWith('…'), true);
  assert.equal(clampSubagentText('short', 2_000), 'short');
});

test('extractSubagentSummary picks the last non-empty AI message', () => {
  const state = {
    messages: [
      { type: 'ai', content: [{ type: 'text', text: '中间结论' }] },
      { type: 'tool', content: 'tool output' },
      { type: 'ai', content: [{ type: 'text', text: '最终摘要' }] },
    ],
  };
  assert.equal(extractSubagentSummary(state), '最终摘要');
  // 摘要缺失时返回空串，由调用方转成失败说明而不是抛异常。
  assert.equal(extractSubagentSummary({ messages: [{ type: 'tool', content: 'x' }] }), '');
  assert.equal(extractSubagentSummary(null), '');
});

test('extractSubagentResult flags model-call-limit notice and keeps partial output', () => {
  const state = {
    messages: [
      { type: 'ai', content: [{ type: 'text', text: '中断前的部分调研结论' }] },
      { type: 'tool', content: 'tool output' },
      // modelCallLimitMiddleware(exitBehavior:'end') 注入的上限通知
      { type: 'ai', content: 'Model call limits exceeded: run level call limit reached with 50 model calls' },
    ],
  };
  const result = extractSubagentResult(state);
  assert.equal(result.limited, true);
  assert.equal(result.summary, '中断前的部分调研结论');

  // 正常结束：不误判。
  const ok = extractSubagentResult({
    messages: [{ type: 'ai', content: '正常最终摘要' }],
  });
  assert.deepEqual(ok, { summary: '正常最终摘要', limited: false });

  // 只有上限通知、没有任何真实产出。
  const onlyNotice = extractSubagentResult({
    messages: [{ type: 'ai', content: 'Model call limits exceeded' }],
  });
  assert.deepEqual(onlyNotice, { summary: '', limited: true });
});

test('spawn schema applies sync-mode defaults and validates bounds', () => {
  const parsed = spawnSubagentSchema.parse({ role_prompt: '角色', task: '任务' });
  assert.equal(parsed.background, false);
  assert.equal(parsed.model_tier, 'fast');
  assert.throws(() => spawnSubagentSchema.parse({ role_prompt: '', task: '任务' }));
  assert.throws(() => spawnSubagentSchema.parse({ role_prompt: '角色' }));
});

test('spawn tool without background ctx returns fallback guidance instead of throwing', async () => {
  const spawnTool = createSpawnSubagentTool({
    runId: 'run-1',
    router: { primary: null, middleware: null },
    tools: [],
  });
  const output = await spawnTool.invoke({
    role_prompt: '角色',
    task: '任务',
    background: true,
  });
  assert.match(String(output), /后台派发运行上下文不可用/);
});

const baseInput: SpawnSubagentInput = {
  role_prompt: '研究员',
  task: '产出简报，验收：含 3 个来源 URL',
  model_tier: 'fast',
  background: false,
};
const baseOptions: SpawnSubagentOptions = {
  runId: 'run-1',
  router: { primary: null, middleware: null },
  tools: [],
};

function verdict(passed: boolean, feedback = '缺少来源 URL') {
  return reviewVerdictSchema.parse({
    passed,
    score: passed ? 90 : 55,
    feedback: passed ? '' : feedback,
    checklist: [{ item: '含 3 个来源 URL', met: passed }],
  });
}

/** 组装闭环测试用的假依赖：run/review 按队列返回，事件落数组。 */
function makeDeps(
  runResults: Array<{ status: SubagentRunStatus; summary: string }>,
  reviews: ReviewOutcome[],
) {
  const events: AgentEvent[] = [];
  const runInputs: SpawnSubagentInput[] = [];
  const deps: SpawnLoopDeps = {
    async run(_options, input) {
      runInputs.push(input);
      const result = runResults[Math.min(runInputs.length - 1, runResults.length - 1)];
      if (!result) throw new Error('unexpected extra run');
      return { status: result.status, summary: result.summary, toolCalls: runInputs.length * 2 };
    },
    review: async () => reviews.shift() ?? { skipped: true },
    emit(_config, event) {
      events.push(event);
    },
  };
  return { deps, events, runInputs };
}

test('review verdict schema validates bounds', () => {
  assert.equal(reviewVerdictSchema.parse(verdict(true)).passed, true);
  assert.throws(() => reviewVerdictSchema.parse({ passed: true, score: 101, feedback: '', checklist: [] }));
});

test('reviewSubagentOutput parses structured result and fails open', async () => {
  const fakeModel = (invokeResult: unknown, shouldThrow = false) => ({
    withStructuredOutput: () => ({
      invoke: async () => {
        if (shouldThrow) throw new Error('boom');
        return invokeResult;
      },
    }),
  });
  const ok = await reviewSubagentOutput(fakeModel(verdict(true)), baseInput, '产出');
  assert.equal(ok.skipped, false);
  assert.equal(ok.skipped === false && ok.verdict.score, 90);
  // 模型缺失 / 抛错 / 非法结构 → skipped（fail-open，不阻断派发）。
  assert.deepEqual(await reviewSubagentOutput(null, baseInput, 'x'), { skipped: true });
  const broken = await reviewSubagentOutput(fakeModel(null, true), baseInput, 'x');
  assert.deepEqual(broken, { skipped: true });
  const badShape = await reviewSubagentOutput(
    fakeModel({ wrong: true }),
    baseInput,
    'x',
  );
  assert.deepEqual(badShape, { skipped: true });
  // 已中止的信号直接跳过。
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(
    await reviewSubagentOutput(fakeModel(verdict(true)), baseInput, 'x', aborted.signal),
    { skipped: true },
  );
});

test('reviewer falls back across structured-output methods and tolerates missing fields', async () => {
  // 模拟 DeepSeek：jsonMode 被服务拒绝，functionCalling 才成功。
  let firstMethod: string | undefined;
  const model = {
    withStructuredOutput: (_schema: unknown, opts: { method?: string }) => ({
      invoke: async () => {
        if (!firstMethod) firstMethod = opts.method;
        if (opts.method === 'jsonMode') throw new Error('400 response_format unavailable');
        return verdict(true);
      },
    }),
  };
  const ok = await reviewSubagentOutput(model, baseInput, '产出');
  assert.equal(firstMethod, 'jsonMode', '必须先试 jsonMode');
  assert.equal(ok.skipped, false);

  // 模型漏掉 feedback/checklist：宽容解析补默认值，不浪费重派/不静默跳过。
  const missingFields = {
    withStructuredOutput: () => ({
      invoke: async () => ({ passed: true, score: 88 }),
    }),
  };
  const tolerant = await reviewSubagentOutput(missingFields, baseInput, '产出');
  assert.equal(tolerant.skipped, false);
  if (!tolerant.skipped) {
    assert.equal(tolerant.verdict.feedback, '');
    assert.deepEqual(tolerant.verdict.checklist, []);
  }
});

test('appendReviewGap reports missed checklist and stays within summary limit', () => {
  const out = appendReviewGap('正文', verdict(false, '补齐 URL'));
  assert.match(out, /评审未通过（已达重派上限/);
  assert.match(out, /55\/100/);
  assert.match(out, /含 3 个来源 URL/);
  assert.match(out, /补齐 URL/);
  assert.ok(out.length <= 2_000);
});

test('spawn loop passes first attempt: one run and one passed review', async () => {
  const { deps, events, runInputs } = makeDeps(
    [{ status: 'completed', summary: '合格产出' }],
    [{ skipped: false, verdict: verdict(true) }],
  );
  const output = await runSpawnLoop(baseOptions, baseInput, null, deps);
  assert.equal(output, '合格产出');
  assert.equal(runInputs.length, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ['subagent.started', 'subagent.completed', 'subagent.reviewed'],
  );
  const reviewed = events.find((event) => event.type === 'subagent.reviewed');
  assert.equal(reviewed && 'passed' in reviewed && reviewed.passed, true);
});

test('spawn loop retries with prior feedback and passes on second attempt', async () => {
  const { deps, events, runInputs } = makeDeps(
    [
      { status: 'completed', summary: '一版（缺 URL）' },
      { status: 'completed', summary: '二版（补齐 URL）' },
    ],
    [
      { skipped: false, verdict: verdict(false, '补齐 3 个来源 URL') },
      { skipped: false, verdict: verdict(true) },
    ],
  );
  const output = await runSpawnLoop(baseOptions, baseInput, null, deps);
  assert.equal(output, '二版（补齐 URL）');
  assert.equal(runInputs.length, 2);
  // 第二轮输入必须带上首轮整改意见。
  assert.equal(runInputs[1]?.prior_feedback, '补齐 3 个来源 URL');
  const started = events.filter((event) => event.type === 'subagent.started');
  assert.deepEqual(
    started.map((event) => 'attempt' in event && event.attempt),
    [1, 2],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'subagent.reviewed').map((event) =>
      'passed' in event && event.passed,
    ),
    [false, true],
  );
});

test('spawn loop stops after 3 attempts and returns the gap note honestly', async () => {
  const { deps, runInputs } = makeDeps(
    Array.from({ length: 3 }, () => ({ status: 'completed' as const, summary: '始终缺 URL' })),
    Array.from({ length: 3 }, () => ({ skipped: false, verdict: verdict(false) }) satisfies ReviewOutcome),
  );
  const output = await runSpawnLoop(baseOptions, baseInput, null, deps);
  assert.equal(runInputs.length, 3);
  assert.match(output, /评审未通过（已达重派上限/);
});

test('spawn loop skips review on failed/timeout run and on skipped review', async () => {
  const failed = makeDeps(
    [{ status: 'timeout', summary: '超时了' }],
    [{ skipped: false, verdict: verdict(true) }],
  );
  const output1 = await runSpawnLoop(baseOptions, baseInput, null, failed.deps);
  assert.equal(output1, '超时了');
  assert.equal(
    failed.events.some((event) => event.type === 'subagent.reviewed'),
    false,
    '失败/超时不评审',
  );

  const skipped = makeDeps(
    [{ status: 'completed', summary: '产出' }],
    [{ skipped: true }],
  );
  const output2 = await runSpawnLoop(baseOptions, baseInput, null, skipped.deps);
  assert.equal(output2, '产出');
  assert.equal(
    skipped.events.some((event) => event.type === 'subagent.reviewed'),
    false,
    '评审器故障 fail-open：无 reviewed 事件，直接放行',
  );
});

// ---------- P3：后台异步派发 ----------

const startedEvent = (subagentId: string, background: boolean): AgentEvent => ({
  runId: 'run-1',
  timestamp: new Date().toISOString(),
  type: 'subagent.started',
  subagentId,
  role: '研究员',
  description: '任务',
  attempt: 1,
  ...(background ? { background: true } : {}),
});

test('background context registers detached tasks, buffers events and settles in order', async () => {
  const ctx = createBackgroundRunContext();
  let task2Signal!: AbortSignal;
  ctx.register({
    subagentId: 'bg-1',
    role: '研究员',
    description: '任务一',
    run: async (emit) => {
      emit(startedEvent('bg-1', true));
      await new Promise((resolve) => setTimeout(resolve, 30));
      return '摘要一';
    },
  });
  ctx.register({
    subagentId: 'bg-2',
    role: '核查员',
    description: '任务二',
    run: async (emit, signal) => {
      task2Signal = signal;
      emit(startedEvent('bg-2', true));
      return '摘要二';
    },
  });

  assert.equal(ctx.size(), 2, '两个任务注册后即在后台运行');
  // 等微任务+30ms 让事件入队。
  await new Promise((resolve) => setTimeout(resolve, 40));
  const events = ctx.drainEvents();
  assert.deepEqual(
    events.map((event) => event.type === 'subagent.started' && event.subagentId),
    ['bg-1', 'bg-2'],
  );
  assert.equal(ctx.drainEvents().length, 0, 'drain 是一次性取净');

  const results = await ctx.settled();
  assert.equal(ctx.size(), 0);
  assert.deepEqual(
    results.map((result) => [result.subagentId, result.summary]),
    [
      ['bg-1', '摘要一'],
      ['bg-2', '摘要二'],
    ],
  );
  assert.equal(task2Signal.aborted, false, '正常结束不应中止任务');
});

test('background context abortAll cancels task signals and bounds the wait', async () => {
  const ctx = createBackgroundRunContext();
  let aborted = false;
  ctx.register({
    subagentId: 'bg-x',
    role: '研究员',
    description: '长任务',
    run: async (_emit, signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve('已中止');
        });
      }),
  });
  // 等任务真正启动并挂上 abort 监听（真实路径里 abortAll 也只在 pass 结束后才发生）。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const startedAt = Date.now();
  await ctx.abortAll();
  assert.ok(aborted, 'abortAll 必须让任务收到中止信号');
  assert.ok(Date.now() - startedAt < 2_000, '收割不能长时间阻塞 interrupt/error 路径');
  const results = await ctx.settled();
  assert.equal(results[0]?.summary, '已中止');
});

test('background context propagates parent run signal and swallows task throws', async () => {
  const parent = new AbortController();
  const ctx = createBackgroundRunContext(parent.signal);
  let sawSignal = false;
  ctx.register({
    subagentId: 'bg-a',
    role: 'a',
    description: 'a',
    run: async (_emit, signal) => {
      sawSignal = signal.aborted;
      return 'ok';
    },
  });
  ctx.register({
    subagentId: 'bg-b',
    role: 'b',
    description: 'b',
    run: async () => {
      throw new Error('boom');
    },
  });
  parent.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const results = await ctx.settled();
  assert.equal(sawSignal, true, '主 run 信号必须组合进任务信号');
  assert.match(results[1]?.summary ?? '', /异常中止/, '任务抛错被收敛为中止摘要，不打断 settled');
});

test('spawn tool background=true returns ack immediately and registers a detached run', async () => {
  const ctx = createBackgroundRunContext();
  const seenOverrides: Array<{ subagentId: string; background?: boolean }> = [];
  const spawnTool = createSpawnSubagentTool(
    { runId: 'run-1', router: { primary: null, middleware: null }, tools: [] },
    {
      runSpawnLoop: async (_options, _input, _config, deps, override) => {
        const loopDeps = deps as SpawnLoopDeps;
        const over = override as { subagentId: string; background?: boolean };
        seenOverrides.push(over);
        loopDeps.emit(_config, startedEvent(over.subagentId, over.background ?? false));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return '后台摘要';
      },
    },
  );

  const start = Date.now();
  const ack = await spawnTool.invoke(
    { ...baseInput, background: true },
    { configurable: { backgroundCtx: ctx } },
  );
  assert.ok(Date.now() - start < 100, '工具必须立即返回，不等待子任务');
  assert.equal(ctx.size(), 1);
  assert.match(String(ack), /后台子任务已启动/);

  const results = await ctx.settled();
  assert.equal(results[0]?.summary, '后台摘要');
  assert.equal(seenOverrides[0]?.background, true);
  const started = ctx.drainEvents()[0];
  assert.equal(started?.type, 'subagent.started');
  // ack 里告知的 taskId 与事件/subagentId 一致，主 Agent 可引用。
  assert.match(String(ack), new RegExp(results[0]?.subagentId ?? ''));
});
