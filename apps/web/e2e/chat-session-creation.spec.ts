import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('creating a session locks the composer until the new conversation is ready', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  let created: Record<string, unknown> | undefined;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/agent/sessions?*', (route) => route.fulfill({ json: {
    data: created ? [created] : [], nextCursor: null,
  } }));
  await page.route('**/api/agent/sessions', async (route) => {
    created = { id: 'new-session', ...route.request().postDataJSON(),
      createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' };
    await pending;
    await route.fulfill({ status: 201, json: created });
  });
  await mockJson(page, '**/api/agent/sessions/new-session/files', { files: [] });
  await page.route('**/api/agent/sessions/new-session/history', (route) => route.fulfill({
    json: { session: created, messages: [], latestRun: null },
  }));
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: '输入消息', exact: true });
  await expect(composer).toBeEnabled();
  await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/agent/sessions')),
    page.getByRole('button', { name: '新建对话', exact: true }).click(),
  ]);
  try {
    await expect(composer).toBeDisabled();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.getByRole('button', { name: '打开对话：新会话', exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  await composer.fill('ready input stays');
  await expect(composer).toHaveValue('ready input stays');
});
