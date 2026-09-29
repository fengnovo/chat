import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('流结束时本地没有正文会从服务端恢复已保存的回复', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = {
    id: 'session-recovery', title: '联网工具', externalKey: 'chat-recovery',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-recovery/files', { files: [] });
  await mockJson(page, '**/api/agent/runs/run-recovery', {
    id: 'run-recovery', sessionId: session.id, status: 'completed',
    errorCode: null, errorMessage: null,
  });
  let historyReads = 0;
  await page.route('**/api/agent/sessions/session-recovery/history', async (route) => {
    historyReads += 1;
    await route.fulfill({ json: {
      session,
      messages: historyReads === 1 ? [] : [
        { id: 'user-run-recovery', runId: 'run-recovery', role: 'user',
          text: '你没有联网工具吗', createdAt: session.createdAt },
        { id: 'message-run-recovery', runId: 'run-recovery', role: 'assistant',
          text: '有联网工具，刚才调用失败了。', createdAt: session.updatedAt,
          reasoning: '让我检查联网工具。' },
      ],
      latestRun: historyReads === 1 ? null : {
        id: 'run-recovery', sessionId: session.id, status: 'completed',
        errorCode: null, errorMessage: null,
      },
    } });
  });
  await page.route('**/api/chat', async (route) => {
    const chunks = [
      { type: 'start', messageId: 'message-run-recovery', messageMetadata: { runId: 'run-recovery' } },
      { type: 'data-agent', transient: true, data: {
        type: 'assistant.reasoning', runId: 'run-recovery',
        timestamp: '2026-09-29T00:00:01.000Z', text: '让我检查联网工具。',
      } },
      { type: 'data-agent', transient: true, data: {
        type: 'run.completed', runId: 'run-recovery',
        timestamp: '2026-09-29T00:00:02.000Z',
      } },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-recovery', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：联网工具' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('你没有联网工具吗');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('有联网工具，刚才调用失败了。')).toBeVisible();
  await expect(page.getByText('本轮没有返回任何内容，可以重新发送这条消息。')).toHaveCount(0);
});

test('任务真正结束但只有思考内容时不再显示思考中', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = {
    id: 'session-empty', title: '空回复会话', externalKey: 'chat-empty',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-empty/files', { files: [] });
  await mockJson(page, '**/api/agent/sessions/session-empty/history', {
    session, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/runs/run-empty', {
    id: 'run-empty', sessionId: session.id, status: 'completed',
    errorCode: null, errorMessage: null,
  });
  await page.route('**/api/chat', async (route) => {
    const chunks = [
      { type: 'start', messageId: 'message-run-empty', messageMetadata: { runId: 'run-empty' } },
      { type: 'data-agent', transient: true, data: {
        type: 'assistant.reasoning', runId: 'run-empty',
        timestamp: '2026-09-29T00:00:01.000Z', text: '正在分析。',
      } },
      { type: 'data-agent', transient: true, data: {
        type: 'run.completed', runId: 'run-empty', timestamp: '2026-09-29T00:00:02.000Z',
      } },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-empty', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：空回复会话' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('你好');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('本轮没有返回任何内容，可以重新发送这条消息。')).toHaveCount(0);
  await expect(page.getByText('思考中')).toHaveCount(0);
  await expect(page.getByText('思考过程', { exact: true })).toBeVisible();
  await expect(page.getByText('Agent 没有给出最终回复')).toBeVisible();
});

test('流提前断开且任务仍运行时会重连获取正文', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = {
    id: 'session-pending', title: '运行中会话', externalKey: 'chat-pending',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-pending/files', { files: [] });
  await mockJson(page, '**/api/agent/sessions/session-pending/history', {
    session, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/runs/run-pending', {
    id: 'run-pending', sessionId: session.id, status: 'running',
    errorCode: null, errorMessage: null,
  });
  await page.route('**/api/chat', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-pending', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: `data: ${JSON.stringify({ type: 'start', messageId: 'message-run-pending',
        messageMetadata: { runId: 'run-pending' } })}\n\n`,
    });
  });
  let reconnects = 0;
  await page.route('**/api/chat/run-pending/stream*', async (route) => {
    reconnects += 1;
    const chunks = [
      { type: 'start', messageId: 'message-run-pending', messageMetadata: { runId: 'run-pending' } },
      { type: 'text-start', id: 'text-run-pending' },
      { type: 'text-delta', id: 'text-run-pending', delta: '重新连上后收到了回复。' },
      { type: 'text-end', id: 'text-run-pending' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-pending', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：运行中会话' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('你好');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('重新连上后收到了回复。')).toBeVisible();
  expect(reconnects).toBeGreaterThan(0);
});
