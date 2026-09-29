import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('新消息在 Worker 排队时立即显示等待状态', async ({ page }) => {
  const session = {
    id: 'session-queue', title: '排队会话', externalKey: 'chat-queue',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-queue/history', {
    session, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-queue/files', { files: [] });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== '/api/chat' || init?.method !== 'POST') return originalFetch(input, init);
      const stream = new ReadableStream<Uint8Array>();
      return Promise.resolve(new Response(stream, { status: 200, headers: {
        'content-type': 'text/event-stream', 'x-workflow-run-id': 'run-queue',
        'x-vercel-ai-ui-message-stream': 'v1',
      } }));
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：排队会话' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('今天的');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('今天的')).toBeVisible();
  await expect(page.getByText('任务已提交，等待 Agent 开始处理…')).toBeVisible();
});

test('轮换两个仍在运行的会话时会立即订阅当前会话的回复', async ({ page }) => {
  const sessions = [
    { id: 'session-a', title: '会话 A', externalKey: 'chat-a',
      createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' },
    { id: 'session-b', title: '会话 B', externalKey: 'chat-b',
      createdAt: '2026-09-29T00:01:00.000Z', updatedAt: '2026-09-29T00:01:00.000Z' },
  ];
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', { data: sessions, nextCursor: null });
  for (const [index, session] of sessions.entries()) {
    const runId = `run-${index}`;
    await mockJson(page, `**/api/agent/sessions/${session.id}/history`, {
      session,
      messages: [{ id: `user-${index}`, runId, role: 'user',
        text: `问题 ${index}`, createdAt: session.createdAt }],
      latestRun: { id: runId, sessionId: session.id, status: index === 0 ? 'running' : 'queued',
        errorCode: null, errorMessage: null },
    });
    await mockJson(page, `**/api/agent/sessions/${session.id}/files`, { files: [] });
    await mockJson(page, `**/api/agent/runs/${runId}`, {
      id: runId, sessionId: session.id, status: index === 0 ? 'running' : 'queued',
      errorCode: null, errorMessage: null,
    });
  }
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    (window as Window & { requestedRunStreams?: string[] }).requestedRunStreams = [];
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const match = url.match(/\/api\/chat\/(run-\d+)\/stream/);
      if (!match) return originalFetch(input, init);
      const runId = match[1];
      (window as Window & { requestedRunStreams?: string[] }).requestedRunStreams?.push(runId);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const payload = { type: 'start', messageId: `message-${runId}`,
            messageMetadata: { runId } };
          if (runId === 'run-0') {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: {
        'content-type': 'text/event-stream', 'x-workflow-run-id': runId,
        'x-vercel-ai-ui-message-stream': 'v1',
      } }));
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：会话 A' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { requestedRunStreams?: string[] }).requestedRunStreams?.length ?? 0,
  )).toBe(1);
  await page.getByRole('button', { name: '打开对话：会话 B' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { requestedRunStreams?: string[] }).requestedRunStreams?.length ?? 0,
  )).toBe(2);
  expect(await page.evaluate(() =>
    (window as Window & { requestedRunStreams?: string[] }).requestedRunStreams,
  )).toEqual(['run-0', 'run-1']);
  await expect(page.getByText('任务已提交，等待 Agent 开始处理…')).toBeVisible();
});

test('旧会话不能重连另一会话的 run 并显示其审批', async ({ page }) => {
  const oldSession = {
    id: 'session-old', title: '深圳旧会话', externalKey: 'chat-old',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  const otherSession = {
    id: 'session-other', title: '北京会话', externalKey: 'chat-other',
    createdAt: '2026-09-29T00:01:00.000Z', updatedAt: '2026-09-29T00:01:00.000Z',
  };
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', {
    data: [oldSession, otherSession], nextCursor: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-old/files', { files: [] });
  await mockJson(page, '**/api/agent/runs/run-other', {
    id: 'run-other', sessionId: otherSession.id,
    status: 'waiting_approval', errorCode: null, errorMessage: null,
  });
  await mockJson(page, '**/api/agent/runs/run-old', {
    id: 'run-old', sessionId: oldSession.id,
    status: 'waiting_approval', errorCode: null, errorMessage: null,
  });
  await page.route('**/api/agent/sessions/session-old/history', async (route) => {
    await route.fulfill({ json: {
      session: oldSession,
      messages: [
        { id: 'user-old', runId: 'run-old', role: 'user', text: '深圳天气', createdAt: oldSession.createdAt },
        { id: 'message-old', runId: 'run-old', role: 'assistant', text: '深圳的旧回复', createdAt: oldSession.updatedAt },
      ],
      latestRun: { id: 'run-old', sessionId: oldSession.id,
        status: 'waiting_approval', errorCode: null, errorMessage: null },
    } });
  });
  const requestedStreams: string[] = [];
  await page.route('**/api/chat/run-other/stream*', async (route) => {
    requestedStreams.push('run-other');
    const approval = {
      type: 'approval.required', runId: 'run-other',
      timestamp: '2026-09-29T00:02:00.000Z', interruptId: 'approval-other',
      actions: [{ name: 'firecrawl_search', summary: '北京今天气温' }],
    };
    const chunks = [
      { type: 'start', messageId: 'message-run-other', messageMetadata: { runId: 'run-other' } },
      { type: 'data-agent', data: approval, transient: true },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-other', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });
  await page.route('**/api/chat/run-old/stream*', async (route) => {
    requestedStreams.push('run-old');
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem('resilient-chat:last-run:e2e-admin', JSON.stringify({
      chatId: 'chat-old', runId: 'run-other', chunkIndex: 0, pending: true,
      messages: [
        { id: 'user-old', role: 'user', parts: [{ type: 'text', text: '深圳天气' }] },
        { id: 'message-old', role: 'assistant', parts: [{ type: 'text', text: '深圳的旧回复' }] },
      ],
    }));
    window.sessionStorage.setItem('resilient-chat:sessions:e2e-admin', JSON.stringify({
      data: [
        { id: 'session-old', title: '深圳旧会话', externalKey: 'chat-old',
          createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' },
        { id: 'session-other', title: '北京会话', externalKey: 'chat-other',
          createdAt: '2026-09-29T00:01:00.000Z', updatedAt: '2026-09-29T00:01:00.000Z' },
      ], nextCursor: null,
    }));
  });

  await page.goto('/');
  await expect(page.getByText('深圳的旧回复')).toBeVisible();
  await page.waitForTimeout(500);
  expect(requestedStreams).not.toContain('run-other');
  await expect(page.getByRole('region', { name: '等待操作审批' })).toHaveCount(0);
});

test('切换会话后才返回的旧请求不能覆盖当前 run 指针', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const first = {
    id: 'session-first', title: '第一条会话', externalKey: 'chat-first',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  const third = {
    id: 'session-third', title: '第三条旧会话', externalKey: 'chat-third',
    createdAt: '2026-09-29T00:01:00.000Z', updatedAt: '2026-09-29T00:01:00.000Z',
  };
  await mockJson(page, '**/api/agent/sessions?*', { data: [first, third], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-first/files', { files: [] });
  await mockJson(page, '**/api/agent/sessions/session-third/files', { files: [] });
  await mockJson(page, '**/api/agent/sessions/session-first/history', {
    session: first, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-third/history', {
    session: third,
    messages: [{ id: 'user-third', runId: 'run-third', role: 'user',
      text: '深圳旧问题', createdAt: third.createdAt },
    { id: 'message-third', runId: 'run-third', role: 'assistant',
      text: '深圳旧回复', createdAt: third.updatedAt }],
    latestRun: { id: 'run-third', sessionId: third.id,
      status: 'completed', errorCode: null, errorMessage: null },
  });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let held = false;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!held && url === '/api/chat' && init?.method === 'POST') {
        held = true;
        return new Promise<Response>((resolve) => {
          (window as Window & { releaseHeldChat?: () => void }).releaseHeldChat = () => {
            const chunks = [
              { type: 'start', messageId: 'message-run-first', messageMetadata: { runId: 'run-first' } },
              { type: 'text-start', id: 'text-run-first' },
              { type: 'text-delta', id: 'text-run-first', delta: '第一条回复' },
              { type: 'text-end', id: 'text-run-first' },
              { type: 'finish', finishReason: 'stop' },
            ];
            resolve(new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
              status: 200,
              headers: { 'content-type': 'text/event-stream',
                'x-workflow-run-id': 'run-first', 'x-vercel-ai-ui-message-stream': 'v1' },
            }));
          };
        });
      }
      return originalFetch(input, init);
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：第一条会话' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('深圳天气');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.waitForFunction(() =>
    typeof (window as Window & { releaseHeldChat?: () => void }).releaseHeldChat === 'function');
  await page.getByRole('button', { name: '打开对话：第三条旧会话' }).click();
  await expect(page.getByText('深圳旧回复')).toBeVisible();
  await page.evaluate(() =>
    (window as Window & { releaseHeldChat?: () => void }).releaseHeldChat?.());
  await page.waitForTimeout(300);
  const activeRun = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('resilient-chat:last-run:e2e-admin') ?? 'null'));
  expect(activeRun).toMatchObject({ chatId: 'chat-third', runId: 'run-third' });
});

test('流里混入其他 run 的审批事件不会显示或提交', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = {
    id: 'session-current', title: '当前会话', externalKey: 'chat-current',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-current/history', {
    session, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-current/files', { files: [] });
  await mockJson(page, '**/api/agent/runs/run-current', {
    id: 'run-current', sessionId: session.id,
    status: 'completed', errorCode: null, errorMessage: null,
  });
  let approvalPosts = 0;
  await page.route('**/api/agent/runs/run-other/approvals/*', async (route) => {
    approvalPosts += 1;
    await route.fulfill({ json: { status: 'running' } });
  });
  await page.route('**/api/chat', async (route) => {
    const approval = {
      type: 'approval.required', runId: 'run-other',
      timestamp: '2026-09-29T00:02:00.000Z', interruptId: 'other-approval',
      actions: [{ name: 'firecrawl_search', summary: '北京今天气温' }],
    };
    const chunks = [
      { type: 'start', messageId: 'message-run-current', messageMetadata: { runId: 'run-current' } },
      { type: 'data-agent', data: approval, transient: true },
      { type: 'text-start', id: 'text-run-current' },
      { type: 'text-delta', id: 'text-run-current', delta: '当前回复' },
      { type: 'text-end', id: 'text-run-current' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-current', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：当前会话' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('深圳天气');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('当前回复')).toBeVisible();
  const foreignApproval = page.getByRole('region', { name: '等待操作审批' });
  if (await foreignApproval.count()) {
    await foreignApproval.getByRole('button', { name: '本会话都允许' }).click();
  }
  expect(approvalPosts).toBe(0);
  await expect(foreignApproval).toHaveCount(0);
});

test('当前会话的审批可以提交给所属 run', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = {
    id: 'session-current', title: '深圳会话', externalKey: 'chat-current',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-current/history', {
    session, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-current/files', { files: [] });
  await mockJson(page, '**/api/agent/runs/run-current', {
    id: 'run-current', sessionId: session.id,
    status: 'waiting_approval', errorCode: null, errorMessage: null,
  });
  let approvalPosts = 0;
  await page.route('**/api/agent/runs/run-current/approvals/approval-current', async (route) => {
    approvalPosts += 1;
    await route.fulfill({ json: { status: 'running' } });
  });
  await page.route('**/api/chat', async (route) => {
    const chunks = [
      { type: 'start', messageId: 'message-current', messageMetadata: { runId: 'run-current' } },
      { type: 'data-agent', transient: true, data: {
        type: 'approval.required', runId: 'run-current',
        timestamp: '2026-09-29T00:02:00.000Z', interruptId: 'approval-current',
        actions: [{ name: 'firecrawl_search', summary: '深圳今天气温' }],
      } },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-current', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：深圳会话' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('深圳天气');
  await page.getByRole('button', { name: '发送消息' }).click();
  const approval = page.getByRole('region', { name: '等待操作审批' });
  await expect(approval).toBeVisible();
  const activeRun = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('resilient-chat:last-run:e2e-admin') ?? 'null'));
  expect(activeRun).toMatchObject({ chatId: 'chat-current', runId: 'run-current' });
  await approval.getByRole('button', { name: '仅批准这一次' }).click();
  await expect.poll(() => approvalPosts).toBe(1);
  await expect(approval).toHaveCount(0);
});
