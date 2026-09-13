import type { SessionPage, SessionSummary, WebSessionSummary } from './types';

async function fetchSessionPage(cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/agent/sessions?${query}`, { signal });
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
  const response = await fetch(`/api/agent/sessions/${sessionId}/files`, { signal });
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
  documents?: KnowledgeDocument[];
};
async function fetchKnowledgeBases(signal?: AbortSignal) { const response = await fetch('/api/knowledge-bases', { signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return (await response.json() as { data: KnowledgeBase[] }).data; }
async function fetchKnowledgeDocuments(kbId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/knowledge-bases/${kbId}/documents`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json() as { data: KnowledgeDocument[] }).data;
}
async function createKnowledgeBase(input: { name: string; description?: string; visibility?: 'private' | 'tenant' }) { const response = await fetch('/api/knowledge-bases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json() as KnowledgeBase; }
async function uploadKnowledgeDocument(kbId: string, file: File) {
  const content = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', content);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const mime = file.type === 'text/plain' || /\.txt$/i.test(file.name)
    ? 'text/plain'
    : 'text/markdown';
  const response = await fetch(`/api/knowledge-bases/${kbId}/documents/uploads`, {
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

  const confirmResponse = await fetch(
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
async function deleteKnowledgeBase(kbId: string) { const response = await fetch(`/api/knowledge-bases/${kbId}`, { method: 'DELETE' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); }
export { fetchKnowledgeBases, fetchKnowledgeDocuments, createKnowledgeBase, uploadKnowledgeDocument, deleteKnowledgeBase, type KnowledgeBase, type KnowledgeDocument };
