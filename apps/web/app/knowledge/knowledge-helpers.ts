import type { KnowledgeDocument } from './knowledge-api';

export const DOCUMENT_ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';

export type UploadState = {
  kind: 'uploading' | 'success' | 'error';
  message: string;
};

export const DOCUMENT_LOAD_ERROR = '文档加载失败，请点击“刷新文档”重试。';

export function isAcceptedKnowledgeFile(name: string) {
  return /\.(?:md|markdown|txt)$/i.test(name);
}

/** 同一知识库同一时刻只允许一个上传任务。 */
export function reserveKnowledgeUpload(active: Set<string>, kbId: string) {
  if (active.has(kbId)) return false;
  active.add(kbId);
  return true;
}

export async function finishKnowledgeUpload(
  fileName: string,
  upload: () => Promise<unknown>,
  refreshDocuments: () => Promise<unknown>,
): Promise<UploadState> {
  await upload();
  try {
    await refreshDocuments();
    return { kind: 'success', message: `${fileName} 已上传，正在等待索引。` };
  } catch {
    return {
      kind: 'error',
      message: `${fileName} 已上传，但文档列表刷新失败，请点击“刷新文档”重试。`,
    };
  }
}

export async function loadKnowledgeDocumentLists(
  bases: Array<{ id: string }>,
  fetchDocuments: (kbId: string) => Promise<KnowledgeDocument[]>,
) {
  const results = await Promise.all(
    bases.map(async (base) => {
      try {
        return { kbId: base.id, documents: await fetchDocuments(base.id) };
      } catch {
        return { kbId: base.id, error: DOCUMENT_LOAD_ERROR };
      }
    }),
  );
  const documents: Record<string, KnowledgeDocument[]> = {};
  const errors: Record<string, string> = {};
  for (const result of results) {
    if (result.documents) documents[result.kbId] = result.documents;
    if (result.error) errors[result.kbId] = result.error;
  }
  return { documents, errors };
}

export function documentStatusLabel(status: string) {
  switch (status) {
    case 'ready':
      return '处理完成';
    case 'failed':
      return '处理失败';
    case 'pending':
      return '待处理';
    case 'queued':
      return '排队中';
    case 'indexing':
    case 'processing':
      return '处理中';
    default:
      return status || '状态未知';
  }
}

export function documentStatusTone(status: string): 'green' | 'red' | 'amber' | 'neutral' {
  if (status === 'ready') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'pending' || status === 'queued' || status === 'indexing' || status === 'processing') return 'amber';
  return 'neutral';
}

export function isDocumentBusy(status: string) {
  return status === 'pending' || status === 'queued' || status === 'indexing' || status === 'processing';
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function retrievalViaLabel(via: string): string {
  if (via === 'vector') return '向量召回';
  if (via === 'graph') return '图谱召回';
  if (via === 'both' || via === 'vector+graph') return '向量+图谱';
  return via;
}
