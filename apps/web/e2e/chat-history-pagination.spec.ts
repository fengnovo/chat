import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('history and files load older pages only on request and preserve the current reply', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = { id: 'paged', title: '分页历史', externalKey: 'chat-paged', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  let olderRequests = 0;
  await page.route('**/api/agent/sessions/paged/history*', async (route) => {
    const older = new URL(route.request().url()).searchParams.has('cursor');
    if (older) olderRequests++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      session, latestRun: null, hasMore: !older, nextCursor: older ? null : 'older-page',
      messages: [{ id: older ? 'message-old' : 'message-new', runId: older ? 'run-old' : 'run-new', role: 'assistant',
        text: older ? '更早的完整回答' : '当前完整回答', createdAt: session.createdAt }],
    }) });
  });
  await page.route('**/api/agent/sessions/paged/files*', async (route) => {
    const older = new URL(route.request().url()).searchParams.has('cursor');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      files: [{ path: older ? 'src/older.ts' : 'src/current.ts', content: 'answer', operation: 'write_file' }],
      hasMore: !older, nextCursor: older ? null : 'more-files',
    }) });
  });
  await page.goto('/');
  await page.getByText('分页历史', { exact: true }).click();
  await expect(page.getByText('当前完整回答', { exact: true })).toBeVisible();
  expect(olderRequests).toBe(0);
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
  await expect(page.getByText('更早的完整回答', { exact: true })).toBeVisible();
  await expect(page.getByText('当前完整回答', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0);
  expect(olderRequests).toBe(1);

  await page.getByRole('button', { name: '显示文件浏览器' }).click();
  const files = page.getByRole('complementary', { name: 'AI 生成的文件' });
  await expect(files.getByText('current.ts', { exact: true })).toBeVisible();
  await files.getByRole('button', { name: '加载更多文件', exact: true }).click();
  await expect(files.getByText('older.ts', { exact: true })).toBeVisible();
  await expect(files.getByText('current.ts', { exact: true })).toBeVisible();
  await expect(files.getByRole('button', { name: '加载更多文件', exact: true })).toHaveCount(0);
});
