import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('refresh replaces a cached reply with the latest messages from another client', async ({ page }) => {
  const session = { id: 'cross-client', title: '跨端刷新', externalKey: 'cross-chat', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:01:00Z' };
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/cross-client/files*', { files: [] });
  await mockJson(page, '**/api/agent/runs/old-run', { id: 'old-run', sessionId: session.id, status: 'completed' });
  await mockJson(page, '**/api/agent/sessions/cross-client/history*', {
    session,
    messages: [
      { id: 'message-old-run', runId: 'old-run', role: 'assistant', text: '原有回答', createdAt: session.createdAt },
      { id: 'message-mobile-run', runId: 'mobile-run', role: 'assistant', text: '手机新增回答', createdAt: session.updatedAt },
    ],
    latestRun: { id: 'mobile-run', sessionId: session.id, status: 'completed' },
  });
  await page.addInitScript(({ session, userId }) => {
    sessionStorage.setItem(`resilient-chat:sessions:${userId}`, JSON.stringify({ data: [session], nextCursor: null }));
    localStorage.setItem(`resilient-chat:last-run:${userId}`, JSON.stringify({
      chatId: session.externalKey, runId: 'old-run', chunkIndex: 10, pending: false,
      messages: [{ id: 'message-old-run', role: 'assistant', parts: [{ type: 'text', text: '原有回答' }] }],
    }));
  }, { session, userId: adminUser.id });
  await page.goto('/');
  await expect(page.getByText('手机新增回答', { exact: true })).toBeVisible();
  await expect(page.getByText('原有回答', { exact: true })).toHaveCount(1);
});
