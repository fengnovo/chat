import { apiFetch } from '../components/resilient-chat/api';
import { detectDocumentMime } from './knowledge-helpers';

export type KnowledgeVisibility = 'private' | 'tenant';

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  visibility: KnowledgeVisibility;
  status: string;
  ownerUserId: string;
  documentCount: number;
  chunkCount: number;
  graphEnabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeDocument = {
  id: string;
  kbId: string;
  name: string;
  mime: string;
  status: string;
  sizeBytes: number;
  chunkCount: number;
  errorMessage: string | null;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeChunk = {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  heading: string | null;
  createdAt: string;
  documentName: string;
};

export type KnowledgeCitation = {
  chunkId: string;
  documentId: string;
  documentName: string;
  ordinal: number;
  heading?: string;
  score: number;
  via: string;
  passage: string;
};

export type KnowledgeSearchResult = {
  retrievalId: string;
  citations: KnowledgeCitation[];
  relations: Array<{ source: string; relation: string; target: string; chunkIds: string[] }>;
  stats: { vectorHits?: number; graphHops?: number; durationMs?: number; [key: string]: unknown };
};

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(input, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function normalizeBase(row: Record<string, unknown>): KnowledgeBase {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    visibility: (row.visibility === 'tenant' ? 'tenant' : 'private') as KnowledgeVisibility,
    status: String(row.status ?? 'ready'),
    ownerUserId: String(row.owner_user_id ?? ''),
    documentCount: Number(row.document_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    graphEnabled: Boolean(row.graph_enabled ?? true),
    chunkSize: Number(row.chunk_size ?? 800),
    chunkOverlap: Number(row.chunk_overlap ?? 100),
    topK: Number(row.top_k ?? 10),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? row.created_at ?? ''),
  };
}

function normalizeDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: String(row.id),
    kbId: String(row.kb_id ?? ''),
    name: String(row.name ?? ''),
    mime: String(row.mime ?? ''),
    status: String(row.status ?? 'pending'),
    sizeBytes: Number(row.size_bytes ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    errorMessage: (row.error_message as string | null) ?? null,
    indexedAt: (row.indexed_at as string | null) ?? null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? row.created_at ?? ''),
  };
}

function normalizeChunk(row: Record<string, unknown>): KnowledgeChunk {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    ordinal: Number(row.ordinal ?? 0),
    text: String(row.text ?? ''),
    tokenCount: Number(row.token_count ?? 0),
    heading: (row.heading as string | null) ?? null,
    createdAt: String(row.created_at ?? ''),
    documentName: String(row.document_name ?? ''),
  };
}

export async function listKnowledgeBases(signal?: AbortSignal): Promise<KnowledgeBase[]> {
  const payload = await requestJson<{ data: Array<Record<string, unknown>> }>('/api/knowledge-bases', { signal });
  return payload.data.map(normalizeBase);
}

export async function createKnowledgeBase(input: {
  name: string;
  description?: string;
  visibility?: KnowledgeVisibility;
}): Promise<KnowledgeBase> {
  const row = await requestJson<Record<string, unknown>>('/api/knowledge-bases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return normalizeBase(row);
}

export async function updateKnowledgeBase(
  kbId: string,
  input: { name?: string; description?: string | null; visibility?: KnowledgeVisibility },
): Promise<KnowledgeBase> {
  const row = await requestJson<Record<string, unknown>>(`/api/knowledge-bases/${kbId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return normalizeBase(row);
}

export async function deleteKnowledgeBase(kbId: string): Promise<void> {
  await requestJson<void>(`/api/knowledge-bases/${kbId}`, { method: 'DELETE' });
}

export async function listKnowledgeDocuments(kbId: string, signal?: AbortSignal): Promise<KnowledgeDocument[]> {
  const payload = await requestJson<{ data: Array<Record<string, unknown>> }>(
    `/api/knowledge-bases/${kbId}/documents`,
    { signal },
  );
  return payload.data.map(normalizeDocument);
}

export async function renameKnowledgeDocument(kbId: string, documentId: string, name: string): Promise<KnowledgeDocument> {
  const row = await requestJson<Record<string, unknown>>(
    `/api/knowledge-bases/${kbId}/documents/${documentId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
  return normalizeDocument(row);
}

export async function deleteKnowledgeDocument(kbId: string, documentId: string): Promise<void> {
  await requestJson<void>(`/api/knowledge-bases/${kbId}/documents/${documentId}`, { method: 'DELETE' });
}

export async function listDocumentChunks(
  kbId: string,
  documentId: string,
  options: { search?: string; signal?: AbortSignal } = {},
): Promise<{ chunks: KnowledgeChunk[]; total: number }> {
  const query = new URLSearchParams();
  if (options.search?.trim()) query.set('q', options.search.trim());
  const payload = await requestJson<{ data: Array<Record<string, unknown>>; total: number }>(
    `/api/knowledge-bases/${kbId}/documents/${documentId}/chunks?${query.toString()}`,
    { signal: options.signal },
  );
  return { chunks: payload.data.map(normalizeChunk), total: payload.total };
}

/** 预签名上传 → PUT 到对象存储 → confirm 触发索引，与后端上传契约保持单一实现。 */
export async function uploadKnowledgeDocument(kbId: string, file: File): Promise<KnowledgeDocument> {
  const content = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', content);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const mime = detectDocumentMime(file.name, file.type);

  const presign = await requestJson<{
    document: Record<string, unknown>;
    upload?: { uploadUrl?: string; url?: string; headers?: Record<string, string> };
  }>(`/api/knowledge-bases/${kbId}/documents/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mime, sizeBytes: file.size, sha256 }),
  });
  const uploadUrl = presign.upload?.uploadUrl ?? presign.upload?.url;
  if (!uploadUrl) throw new Error('上传地址缺失');

  const uploadHeaders = new Headers({ 'Content-Type': mime, 'x-amz-meta-sha256': sha256 });
  for (const [name, value] of Object.entries(presign.upload?.headers ?? {})) {
    uploadHeaders.set(name, value);
  }
  // 直连对象存储失败通常是端口未放行 / CORS / 证书问题，fetch 只会给笼统的 TypeError，单独转译。
  let putResponse: Response;
  try {
    putResponse = await fetch(uploadUrl, { method: 'PUT', body: file, headers: uploadHeaders });
  } catch {
    throw new Error('无法连接文件存储服务（网络超时或被跨域策略拦截），请联系管理员检查对象存储入口');
  }
  if (!putResponse.ok) throw new Error(`对象存储上传失败 HTTP ${putResponse.status}`);

  const confirmed = await requestJson<Record<string, unknown>>(
    `/api/knowledge-bases/${kbId}/documents/${String(presign.document.id)}/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sizeBytes: file.size, sha256 }),
    },
  );
  return normalizeDocument(confirmed);
}

export async function retrieveKnowledge(
  kbId: string,
  input: { query: string; topK: number; minScore: number },
): Promise<KnowledgeSearchResult> {
  return requestJson<KnowledgeSearchResult>(`/api/knowledge-bases/${kbId}/retrieval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function askKnowledge(
  kbId: string,
  input: { question: string; topK: number; minScore: number },
): Promise<{ answer: string; retrieval: KnowledgeSearchResult }> {
  return requestJson<{ answer: string; retrieval: KnowledgeSearchResult }>(
    `/api/knowledge-bases/${kbId}/ask`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}
