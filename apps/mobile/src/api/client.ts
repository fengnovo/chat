import type {
  CurrentUser,
  HistoryResponse,
  RunRecord,
  SessionSummary,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

// Debug and Release must not restore each other's server, credentials or chat.
const storagePrefix = typeof __DEV__ !== 'undefined' && __DEV__
  ? 'keenai.debug'
  : 'keenai.release';
const TOKEN_STORAGE_KEY = `${storagePrefix}.token`;
const SERVER_STORAGE_KEY = `${storagePrefix}.server`;
const CHAT_STORAGE_KEY = `${storagePrefix}.lastChat`;

/**
 * 面向 Fastify Agent API 的移动端客户端。
 * 鉴权走 Authorization: Bearer（登录响应体中的 JWT），不依赖浏览器 Cookie。
 */
export class ApiClient {
  private token: string | null = null;
  private serverUrl: string | null = null;

  get baseUrl(): string {
    if (!this.serverUrl) throw new Error('未配置服务器地址');
    return this.serverUrl.replace(/\/+$/, '');
  }

  get hasSession(): boolean {
    return this.token !== null;
  }

  /** SSE 订阅等非 JSON 请求需要的 Bearer token。 */
  get bearerToken(): string | null {
    return this.token;
  }

  configure(serverUrl: string, token: string | null): void {
    this.serverUrl = serverUrl.trim();
    this.token = token;
  }

  async request<T>(
    path: string,
    init: Omit<RequestInit, 'body' | 'headers'> & {
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const { body, headers: extraHeaders, ...rest } = init;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const code =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : `http_${response.status}`;
      throw new ApiError(response.status, code);
    }
    return payload as T;
  }

  // ---- 认证 ----

  async login(serverUrl: string, username: string, password: string) {
    this.configure(serverUrl, null);
    const result = await this.request<{
      token: string;
      user: CurrentUser;
    }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    await this.forgetChat();
    this.token = result.token;
    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/auth/logout', { method: 'POST' });
    } finally {
      this.token = null;
      await this.forgetChat();
    }
  }

  async me(): Promise<CurrentUser> {
    const result = await this.request<{ user: CurrentUser }>('/api/auth/me');
    return result.user;
  }

  // ---- 会话 ----

  listSessions(cursor?: string | null) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<{ data: SessionSummary[]; nextCursor: string | null }>(
      `/api/agent/sessions${query}`,
    );
  }

  createSession(title?: string) {
    return this.request<SessionSummary>('/api/agent/sessions', {
      method: 'POST',
      body: { ...(title ? { title } : {}) },
    });
  }

  renameSession(sessionId: string, title: string) {
    return this.request<SessionSummary>(`/api/agent/sessions/${sessionId}`, {
      method: 'PATCH',
      body: { title },
    });
  }

  deleteSession(sessionId: string) {
    return this.request<void>(`/api/agent/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }

  history(sessionId: string) {
    return this.request<HistoryResponse>(
      `/api/agent/sessions/${sessionId}/history?includeLatestEvents=1`,
    );
  }

  getSession(sessionId: string) {
    return this.request<SessionSummary>(`/api/agent/sessions/${sessionId}`);
  }

  async rememberChat(sessionId: string, title: string) {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(
      CHAT_STORAGE_KEY,
      JSON.stringify({ sessionId, title }),
    );
  }
  async rememberedChat(): Promise<{ sessionId: string; title: string } | null> {
    const SecureStore = await import('expo-secure-store');
    const raw = await SecureStore.getItemAsync(CHAT_STORAGE_KEY);
    try {
      const value = raw ? JSON.parse(raw) : null;
      return value &&
        typeof value.sessionId === 'string' &&
        typeof value.title === 'string'
        ? value
        : null;
    } catch {
      return null;
    }
  }
  async forgetChat() {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.deleteItemAsync(CHAT_STORAGE_KEY);
  }

  // ---- 运行 ----

  createRun(sessionId: string, message: string, attachmentIds: string[] = []) {
    return this.request<RunRecord>(`/api/agent/sessions/${sessionId}/runs`, {
      method: 'POST',
      body: { message, attachmentIds },
    });
  }

  cancelRun(runId: string) {
    return this.request<{ status: string }>(`/api/agent/runs/${runId}/cancel`, {
      method: 'POST',
    });
  }

  respondApproval(
    runId: string,
    interruptId: string,
    approve: boolean,
    scope: 'once' | 'session' = 'once',
  ) {
    return this.request<{ status: string }>(
      `/api/agent/runs/${runId}/approvals/${interruptId}`,
      {
        method: 'POST',
        body: {
          decision: approve ? 'approve' : 'reject',
          scope: approve ? scope : 'once',
        },
      },
    );
  }

  respondQuestion(
    runId: string,
    interruptId: string,
    selections: { index: number; label: string }[],
    customText?: string,
  ) {
    return this.request<{ status: string }>(
      `/api/agent/runs/${runId}/questions/${interruptId}`,
      {
        method: 'POST',
        body: {
          selections,
          ...(customText ? { customText } : {}),
        },
      },
    );
  }

  // ---- 本地持久化（token / 服务器地址） ----

  async persist(): Promise<void> {
    const SecureStore = await import('expo-secure-store');
    const { setItemAsync, deleteItemAsync } = SecureStore;
    const tasks: Promise<unknown>[] = [
      this.serverUrl
        ? setItemAsync(SERVER_STORAGE_KEY, this.serverUrl)
        : deleteItemAsync(SERVER_STORAGE_KEY),
      this.token
        ? setItemAsync(TOKEN_STORAGE_KEY, this.token)
        : deleteItemAsync(TOKEN_STORAGE_KEY),
    ];
    await Promise.all(tasks);
  }

  async restore(): Promise<boolean> {
    const SecureStore = await import('expo-secure-store');
    const [server, token] = await Promise.all([
      SecureStore.getItemAsync(SERVER_STORAGE_KEY),
      SecureStore.getItemAsync(TOKEN_STORAGE_KEY),
    ]);
    if (!server || !token) return false;
    this.configure(server, token);
    return true;
  }
}

export const api = new ApiClient();
