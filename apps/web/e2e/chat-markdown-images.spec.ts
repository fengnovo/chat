import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('占位图片不请求死链，回复中的图片直链显示预览', async ({ page }) => {
  const session = {
    id: 'session-images', title: '图片回复', externalKey: 'chat-images',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
  };
  const firstUrl = 'https://images.example.test/car.jpg';
  const secondUrl = 'https://images.example.test/interior.png';
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', { data: [session], nextCursor: null });
  await mockJson(page, '**/api/agent/sessions/session-images/files', { files: [] });
  await mockJson(page, '**/api/agent/sessions/session-images/history', {
    session,
    messages: [
      { id: 'user-images', runId: 'run-images', role: 'user',
        text: '显示汽车图片', createdAt: session.createdAt },
      { id: 'message-images', runId: 'run-images', role: 'assistant',
        text: `图片找到了：\n\n![汽车](/upload-placeholder)\n\n${firstUrl}\n\n内饰：\n\n${secondUrl}\n\n![失效的图](https://images.example.test/missing.jpg)\n\nhttps://images.example.test/missing.png`,
        createdAt: session.updatedAt },
    ],
    latestRun: { id: 'run-images', sessionId: session.id, status: 'completed',
      errorCode: null, errorMessage: null },
  });
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
    'base64',
  );
  await page.route('https://images.example.test/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: imageBytes });
  });
  await page.route('https://images.example.test/missing.*', async (route) => {
    await route.fulfill({ status: 404 });
  });
  const placeholderRequests: string[] = [];
  await page.route('**/upload-placeholder', async (route) => {
    placeholderRequests.push(route.request().url());
    await route.fulfill({ status: 404 });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：图片回复' }).click();
  await expect(page.locator('.message-copy img[src="https://images.example.test/car.jpg"]')).toBeVisible();
  await expect(page.locator('.message-copy img[src="https://images.example.test/interior.png"]')).toBeVisible();
  await expect.poll(() => page.locator('.message-copy img[src="https://images.example.test/car.jpg"]')
    .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: '图片加载失败，打开原图' })).toBeVisible();
  await expect(page.getByText('图片预览失败，请打开下方链接')).toBeVisible();
  expect(placeholderRequests).toHaveLength(0);
});
