import type { SessionPage, SessionSummary, WebSessionSummary } from './types';

/** 按扩展名映射到后端接受的 MIME 类型；旧版 .doc/.xls 不支持。 */
function detectMime(name: string, fallbackType = ''): string {
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default:
      return fallbackType || 'application/octet-stream';
  }
}

// 统一 fetch 入口：未登录（401）时跳转登录页；/login 页面内不跳转防止循环。
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (
    response.status === 401 &&
    typeof window !== 'undefined' &&
    !window.location.pathname.startsWith('/login')
  ) {
    window.location.assign('/login');
  }
  return response;
}

async function fetchSessionPage(cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const response = await apiFetch(`/api/agent/sessions?${query}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data: SessionSummary[];
    nextCursor: string | null;
  };
  return {
    data: payload.data.filter(
      (session): session is WebSessionSummary =>
        typeof session.externalKey === 'string' && session.externalKey.length > 0,
    ),
    nextCursor: payload.nextCursor,
  } satisfies SessionPage;
}

type SessionFile = {
  path: string;
  content: string | null;
  operation: string;
};

async function fetchSessionFiles(sessionId: string, signal?: AbortSignal) {
  const response = await apiFetch(`/api/agent/sessions/${sessionId}/files`, { signal });
  if (!response.ok) return [];
  const payload = (await response.json()) as { files: SessionFile[] };
  return payload.files;
}

async function responseError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  const knownErrors: Record<string, string> = {
    session_has_active_run: '这条会话仍在运行，请先停止任务再删除',
    session_not_found: '这条会话不存在或已被删除',
  };
  return payload?.error ? knownErrors[payload.error] ?? fallback : fallback;
}

export { fetchSessionFiles, fetchSessionPage, responseError, type SessionFile };

type KnowledgeDocument = {
  id: string;
  name: string;
  mime?: string;
  status?: string;
  sizeBytes?: number;
  size_bytes?: number | string;
  chunkCount?: number;
  chunk_count?: number;
  errorMessage?: string | null;
  error_message?: string | null;
  indexedAt?: string | null;
  indexed_at?: string | null;
};
type KnowledgeBase = {
  id: string;
  name: string;
  description?: string;
  status?: string;
  owner_user_id?: string | null;
  documents?: KnowledgeDocument[];
};
async function fetchKnowledgeBases(signal?: AbortSignal) { const response = await apiFetch('/api/knowledge-bases', { signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return (await response.json() as { data: KnowledgeBase[] }).data; }
async function fetchKnowledgeDocuments(kbId: string, signal?: AbortSignal) {
  const response = await apiFetch(`/api/knowledge-bases/${kbId}/documents`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json() as { data: KnowledgeDocument[] }).data;
}
async function createKnowledgeBase(input: { name: string; description?: string; visibility?: 'private' | 'tenant' }) { const response = await apiFetch('/api/knowledge-bases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json() as KnowledgeBase; }
async function uploadKnowledgeDocument(kbId: string, file: File) {
  const content = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', content);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const mime = detectMime(file.name, file.type);
  const response = await apiFetch(`/api/knowledge-bases/${kbId}/documents/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mime, sizeBytes: file.size, sha256 }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json() as {
    document: KnowledgeDocument;
    upload?: {
      uploadUrl?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    uploadUrl?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  const upload = payload.upload ?? payload;
  const uploadUrl = upload.uploadUrl ?? upload.url;
  if (!uploadUrl) throw new Error('Upload URL is missing');

  const uploadHeaders = new Headers({
    'Content-Type': mime,
    'x-amz-meta-sha256': sha256,
  });
  for (const [name, value] of Object.entries(upload.headers ?? {})) {
    uploadHeaders.set(name, value);
  }
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: uploadHeaders,
  });
  if (!uploadResponse.ok) throw new Error(`HTTP ${uploadResponse.status}`);

  const confirmResponse = await apiFetch(
    `/api/knowledge-bases/${kbId}/documents/${payload.document.id}/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sizeBytes: file.size, sha256 }),
    },
  );
  if (!confirmResponse.ok) throw new Error(`HTTP ${confirmResponse.status}`);
  const confirmed = await confirmResponse.json() as
    | KnowledgeDocument
    | { document: KnowledgeDocument };
  return 'document' in confirmed ? confirmed.document : confirmed;
}
async function deleteKnowledgeBase(kbId: string) { const response = await apiFetch(`/api/knowledge-bases/${kbId}`, { method: 'DELETE' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); }
export { fetchKnowledgeBases, fetchKnowledgeDocuments, createKnowledgeBase, uploadKnowledgeDocument, deleteKnowledgeBase, type KnowledgeBase, type KnowledgeDocument };

// ---- 认证与当前用户 ----
export type CurrentUser = {
  id: string;
  displayName: string;
  role: 'admin' | 'owner' | 'member';
  tenantId: string;
  authMode?: 'dev' | 'password' | 'oidc';
};

export async function fetchCurrentUser(signal?: AbortSignal): Promise<CurrentUser | null> {
  const response = await fetch('/api/auth/me', { signal });
  if (!response.ok) return null;
  const payload = (await response.json()) as { user?: CurrentUser };
  return payload.user ?? null;
}

export async function login(username: string, password: string): Promise<CurrentUser> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'invalid_credentials' : `HTTP ${response.status}`);
  const payload = (await response.json()) as { user: CurrentUser };
  return payload.user;
}

export type RegisterInput = {
  username: string;
  displayName: string;
  password: string;
};

export async function register(input: RegisterInput): Promise<CurrentUser> {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (response.ok) {
    return ((await response.json()) as { user: CurrentUser }).user;
  }
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  if (response.status === 403 && payload?.error === 'signup_disabled') {
    throw new Error('signup_disabled');
  }
  if (response.status === 409) {
    throw new Error('username_taken');
  }
  throw new Error(payload?.error ?? `HTTP ${response.status}`);
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

// ---- 管理员：用户管理与知识库授权 ----
export type AdminUser = {
  id: string;
  username: string | null;
  displayName: string;
  role: 'admin' | 'owner' | 'member';
  grantedKbCount: number;
  createdAt: string;
};

async function requireOk(response: Response, fallback: string) {
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? fallback);
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const response = await apiFetch('/api/admin/users');
  await requireOk(response, '加载用户失败');
  return (await response.json() as { data: AdminUser[] }).data;
}

export async function createAdminUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: AdminUser['role'];
}): Promise<AdminUser> {
  const response = await apiFetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await requireOk(response, '创建用户失败');
  return await response.json() as AdminUser;
}

export async function updateAdminUser(
  userId: string,
  patch: { role?: AdminUser['role']; displayName?: string; password?: string },
): Promise<void> {
  const response = await apiFetch(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await requireOk(response, '更新用户失败');
}

export async function fetchUserKbGrants(userId: string): Promise<string[]> {
  const response = await apiFetch(`/api/admin/users/${userId}/knowledge-bases`);
  await requireOk(response, '加载授权失败');
  return (await response.json() as { data: string[] }).data;
}

export async function replaceUserKbGrants(userId: string, knowledgeBaseIds: string[]): Promise<void> {
  const response = await apiFetch(`/api/admin/users/${userId}/knowledge-bases`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ knowledgeBaseIds }),
  });
  await requireOk(response, '保存授权失败');
}
