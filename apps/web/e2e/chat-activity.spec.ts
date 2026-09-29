import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('SSE 重放工具事件时执行日志不产生重复 key', async ({ page }) => {
  const duplicateKeyErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('same key')) {
      duplicateKeyErrors.push(message.text());
    }
  });
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', { data: [], nextCursor: null });
  await mockJson(page, '**/api/agent/runs/run-replay', {
    id: 'run-replay', status: 'completed', errorCode: null, errorMessage: null,
  });
  await page.route('**/api/chat', async (route) => {
    const toolEvent = {
      type: 'tool.started', runId: 'run-replay',
      timestamp: '2026-09-29T00:00:00.000Z',
      invocationId: 'call-1', tool: 'read_file', input: { path: 'index.ts' },
    };
    const chunks = [
      { type: 'start', messageId: 'message-run-replay', messageMetadata: { runId: 'run-replay' } },
      { type: 'data-agent', data: toolEvent, transient: true },
      { type: 'data-agent', data: toolEvent, transient: true },
      { type: 'text-start', id: 'text-run-replay' },
      { type: 'text-delta', id: 'text-run-replay', delta: '完成' },
      { type: 'text-end', id: 'text-run-replay' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-replay', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('textbox', { name: '输入消息' }).fill('读取文件');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('完成')).toBeVisible();
  await page.getByRole('button', { name: /执行日志/ }).click();
  await expect(page.locator('.process-tool')).toHaveCount(1);
  expect(duplicateKeyErrors).toEqual([]);
});
