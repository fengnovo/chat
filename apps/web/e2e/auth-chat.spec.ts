import { test, expect, adminUser, mockAuth, mockJson } from './fixtures';

test('登录页展示 OAuth 错误，并能反馈密码登录失败', async ({ page }) => {
  await mockAuth(page, null);
  await mockJson(page, '**/api/auth/oauth/providers', { providers: [] });
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_credentials' }) });
  });

  await page.goto('/login?error=oauth_failed&detail=e2e');
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  const loginError = page.locator('p.login-error');
  await expect(loginError).toContainText('第三方登录失败');

  await page.getByLabel('用户名').fill('wrong-user');
  await page.getByLabel('密码').fill('wrong-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(loginError).toHaveText('用户名或密码错误');
});

test('聊天页可切换历史会话、打开文件面板并预览图片灯箱', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', {
    data: [{
      id: 'session-1',
      title: '历史对话',
      externalKey: 'chat-1',
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    }],
    nextCursor: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-1/history', {
    session: {
      id: 'session-1',
      title: '历史对话',
      externalKey: 'chat-1',
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    },
    messages: [{
      id: 'message-1',
      runId: 'run-1',
      role: 'user',
      text: '请看这张图片',
      createdAt: '2026-09-22T00:00:00.000Z',
      attachments: [{
        id: 'image-1',
        filename: 'sample.png',
        contentType: 'image/png',
        sizeBytes: 10,
        kind: 'image',
        url: '/e2e/sample.png',
      }],
    }],
    latestRun: null,
  });
  await mockJson(page, '**/api/agent/sessions/session-1/files', {
    files: [{ path: 'src/index.ts', content: 'export const answer = 42;', operation: 'write_file' }],
  });

  await page.goto('/');
  await expect(page.getByText('历史对话')).toBeVisible();
  await page.getByText('历史对话').click();
  await expect(page.getByText('请看这张图片')).toBeVisible();

  await page.getByRole('button', { name: '显示文件浏览器' }).click();
  const filePanel = page.getByRole('complementary', { name: 'AI 生成的文件' });
  await expect(filePanel).toBeVisible();
  await expect(filePanel).toContainText('index.ts');
  await expect(filePanel).toContainText('export const answer = 42;');

  await page.locator('button[title="查看大图：sample.png"]').click();
  const lightbox = page.getByRole('dialog', { name: '图片预览：sample.png' });
  await expect(lightbox).toBeVisible();
  await page.getByRole('button', { name: '放大' }).click();
  await expect(lightbox.getByText('125%')).toBeVisible();
  await lightbox.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(lightbox).toBeHidden();

  await page.getByRole('button', { name: '关闭文件面板' }).click();
  await expect(filePanel).toBeHidden();
});

test('新建会话时旧会话的运行继续，切回后能看到后台生成的回复', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const firstSession = {
    id: 'session-first',
    title: '你好，陈水扁',
    externalKey: 'chat-first',
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
  const secondSession = {
    id: 'session-second',
    title: '新会话',
    externalKey: 'chat-second',
    createdAt: '2026-09-29T00:01:00.000Z',
    updatedAt: '2026-09-29T00:01:00.000Z',
  };
  let created = false;
  let cancelled = false;
  let historyReads = 0;
  await page.route('**/api/agent/sessions?*', async (route) => {
    await route.fulfill({ json: {
      data: created ? [secondSession, firstSession] : [firstSession],
      nextCursor: null,
    } });
  });
  await page.route('**/api/agent/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    created = true;
    const body = route.request().postDataJSON() as { externalKey: string };
    secondSession.externalKey = body.externalKey;
    await route.fulfill({ json: secondSession });
  });
  await page.route('**/api/agent/sessions/session-first/history', async (route) => {
    historyReads += 1;
    await route.fulfill({ json: {
      session: firstSession,
      messages: [
        {
          id: 'user-run-first', runId: 'run-first', role: 'user',
          text: '你好，陈水扁', createdAt: firstSession.createdAt,
        },
        ...(historyReads > 1 && !cancelled ? [{
          id: 'message-run-first', runId: 'run-first', role: 'assistant',
          text: '你好！', createdAt: secondSession.createdAt,
        }] : []),
      ],
      latestRun: null,
    } });
  });
  await mockJson(page, '**/api/agent/sessions/session-first/files', { files: [] });
  await mockJson(page, '**/api/agent/sessions/session-second/files', { files: [] });
  await mockJson(page, '**/api/agent/sessions/session-second/history', {
    session: secondSession, messages: [], latestRun: null,
  });
  await mockJson(page, '**/api/agent/runs/run-first', {
    id: 'run-first', sessionId: firstSession.id,
    status: 'running', errorCode: null, errorMessage: null,
  });
  await mockJson(page, '**/api/agent/runs/run-second', {
    id: 'run-second', sessionId: secondSession.id,
    status: 'completed', errorCode: null, errorMessage: null,
  });
  await page.route('**/api/chat/run-first/stream*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
  });
  await page.route('**/api/agent/runs/run-first/cancel', async (route) => {
    cancelled = true;
    await route.fulfill({ json: { status: 'cancelling' } });
  });
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON() as {
      chat_id: string;
      messages: Array<{ parts: Array<{ type: string; text?: string }> }>;
    };
    expect(body.chat_id).toBe(secondSession.externalKey);
    expect(body.messages.at(-1)?.parts).toContainEqual({ type: 'text', text: '你很棒' });
    secondSession.title = '你很棒';
    const chunks = [
      { type: 'start', messageId: 'message-run-second', messageMetadata: { runId: 'run-second' } },
      { type: 'text-start', id: 'text-run-second' },
      { type: 'text-delta', id: 'text-run-second', delta: '谢谢！' },
      { type: 'text-end', id: 'text-run-second' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      headers: { 'x-workflow-run-id': 'run-second', 'x-vercel-ai-ui-message-stream': 'v1' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开对话：你好，陈水扁' }).click();
  await expect(page.getByText('你好，陈水扁').last()).toBeVisible();
  // 模拟首条消息已经提交，Worker 正在后台运行，浏览器保存了 run 指针。
  await page.evaluate(() => window.localStorage.setItem(
    'resilient-chat:last-run:e2e-admin',
    JSON.stringify({ chatId: 'chat-first', runId: 'run-first', chunkIndex: 0,
      messages: [{ id: 'user-run-first', role: 'user', parts: [{ type: 'text', text: '你好，陈水扁' }] }],
      pending: true }),
  ));

  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.getByRole('button', { name: '打开对话：新会话' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建对话' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '打开对话：新会话' })).toHaveAttribute('aria-current', 'page');
  expect(cancelled).toBe(false);
  await page.getByRole('textbox', { name: '输入消息' }).fill('你很棒');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('谢谢！')).toBeVisible();
  await page.getByRole('button', { name: '打开对话：你好，陈水扁' }).click();
  await expect(page.getByText('你好！')).toBeVisible();
});

test('删除会话后刷新页面不会从缓存恢复已删除的会话', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  const session = {
    id: 'session-to-delete',
    title: '待删除会话',
    externalKey: 'chat-to-delete',
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
  let deleted = false;
  await page.route('**/api/agent/sessions?*', async (route) => {
    await route.fulfill({ json: {
      data: deleted ? [] : [session],
      nextCursor: null,
    } });
  });
  await page.route('**/api/agent/sessions/session-to-delete', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deleted = true;
    await route.fulfill({ status: 204 });
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开对话：待删除会话' })).toBeVisible();
  await page.getByRole('button', { name: '管理对话：待删除会话' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除这条会话？' })
    .getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('button', { name: '打开对话：待删除会话' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('button', { name: '打开对话：待删除会话' })).toHaveCount(0);
});

test('已有过期会话缓存时会从服务端同步删除状态', async ({ page }) => {
  await mockAuth(page, adminUser);
  await mockJson(page, '**/api/knowledge-bases', { data: [] });
  await mockJson(page, '**/api/agent/sessions?*', { data: [], nextCursor: null });
  await page.addInitScript(() => {
    window.sessionStorage.setItem('resilient-chat:sessions:e2e-admin', JSON.stringify({
      data: [{
        id: 'deleted-session', title: '已删除会话', externalKey: 'deleted-chat',
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      }],
      nextCursor: null,
    }));
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开对话：已删除会话' })).toHaveCount(0);
});
