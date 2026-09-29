import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('正常输出 Markdown 时不重连，也不重建已有代码块', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = {
    id: 'session-markdown', title: 'Markdown 流', externalKey: 'chat-markdown',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-markdown/history', {
    session, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-markdown/files', { files: [] });
  await mockJson(page, '**/api/agent/runs/run-markdown', {
    id: 'run-markdown', sessionId: session.id, status: 'running',
    errorCode: null, errorMessage: null,
  });
  const reconnectRequests: string[] = [];
  await page.route('**/api/chat/run-markdown/stream*', async (route) => {
    reconnectRequests.push(route.request().url());
    const chunks = [
      { type: 'start', messageId: 'message-run-markdown', messageMetadata: { runId: 'run-markdown' } },
      { type: 'text-start', id: 'text-run-markdown' },
      { type: 'text-delta', id: 'text-run-markdown', delta: '```js\nconst answer = 42;\n```' },
      { type: 'text-end', id: 'text-run-markdown' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200, contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-markdown', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === '/api/chat' && init?.method === 'POST') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const push = (chunk: Record<string, unknown>) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            (window as Window & { pushMarkdownChunk?: typeof push }).pushMarkdownChunk = push;
            push({ type: 'start', messageId: 'message-run-markdown',
              messageMetadata: { runId: 'run-markdown' } });
            push({ type: 'text-start', id: 'text-run-markdown' });
            push({ type: 'text-delta', id: 'text-run-markdown',
              delta: '```js\nconst answer = ' });
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream',
            'x-workflow-run-id': 'run-markdown', 'x-vercel-ai-ui-message-stream': 'v1' },
        }));
      }
      return originalFetch(input, init);
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：Markdown 流' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('写一段代码');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.message-copy pre')).toContainText('const answer =');
  await page.waitForTimeout(300);
  expect(reconnectRequests).toHaveLength(0);

  await page.evaluate(() => {
    (window as Window & { firstCodeBlock?: Element | null }).firstCodeBlock =
      document.querySelector('.message-copy pre');
    (window as Window & { pushMarkdownChunk?: (chunk: Record<string, unknown>) => void })
      .pushMarkdownChunk?.({ type: 'text-delta', id: 'text-run-markdown', delta: '42;\n' });
  });
  await expect(page.locator('.message-copy pre')).toContainText('42;');
  expect(await page.evaluate(() =>
    document.querySelector('.message-copy pre') ===
      (window as Window & { firstCodeBlock?: Element | null }).firstCodeBlock,
  )).toBe(true);

  // 浏览器切到后台后，恢复可见时仍允许把可能断开的流接回来。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reconnectRequests.length).toBe(1);
  await page.waitForTimeout(300);
  expect(reconnectRequests).toHaveLength(1);
});
