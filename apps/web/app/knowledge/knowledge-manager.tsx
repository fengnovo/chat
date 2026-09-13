'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';

import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  fetchKnowledgeBases,
  fetchKnowledgeDocuments,
  uploadKnowledgeDocument,
  type KnowledgeBase,
  type KnowledgeDocument,
} from '../components/resilient-chat/api';
import { useAuth } from '../components/auth/auth-context';
import { UserMenu } from '../components/auth/user-menu';

const DOCUMENT_ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';
const DOCUMENT_LOAD_ERROR = '文档加载失败，请点击“刷新文档”重试。';

type UploadState = {
  kind: 'uploading' | 'success' | 'error';
  message: string;
};

function isAcceptedKnowledgeFile(name: string) {
  return /\.(?:md|markdown|txt)$/i.test(name);
}

function reserveKnowledgeUpload(active: Set<string>, kbId: string) {
  if (active.has(kbId)) return false;
  active.add(kbId);
  return true;
}

async function finishKnowledgeUpload(
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

async function loadKnowledgeDocumentLists(
  bases: Array<Pick<KnowledgeBase, 'id'>>,
  fetchDocuments: (kbId: string) => Promise<KnowledgeDocument[]>,
) {
  const results = await Promise.all(bases.map(async (base) => {
    try {
      return { kbId: base.id, documents: await fetchDocuments(base.id) };
    } catch {
      return { kbId: base.id, error: DOCUMENT_LOAD_ERROR };
    }
  }));
  const documents: Record<string, KnowledgeDocument[]> = {};
  const errors: Record<string, string> = {};
  for (const result of results) {
    if (result.documents) documents[result.kbId] = result.documents;
    if (result.error) errors[result.kbId] = result.error;
  }
  return { documents, errors };
}

function documentStatusLabel(status?: string) {
  if (status === 'ready') return '可检索';
  if (status === 'failed') return '处理失败';
  if (status === 'pending') return '等待上传';
  if (status === 'queued') return '等待索引';
  return status ?? '状态未知';
}

type KnowledgeBaseCardProps = {
  base: KnowledgeBase;
  canWrite: boolean;
  documents?: KnowledgeDocument[];
  documentLoadError?: string;
  uploadState?: UploadState;
  onFileSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onDelete: () => void;
  onRefresh: () => void;
};

function KnowledgeBaseCard({
  base,
  canWrite,
  documents,
  documentLoadError,
  uploadState,
  onFileSelected,
  onDelete,
  onRefresh,
}: KnowledgeBaseCardProps) {
  const uploading = uploadState?.kind === 'uploading';
  return (
    <article className="knowledge-card">
      <div className="knowledge-card-heading">
        <div>
          <h2>{base.name}</h2>
          {base.description && <p>{base.description}</p>}
        </div>
        <p className="knowledge-base-status">知识库状态：{base.status ?? 'ready'}</p>
      </div>

      <div className="knowledge-card-actions">
        {canWrite && (
          <label className="knowledge-upload-control">
            <span>{uploading ? '上传 Markdown / TXT（上传中…）' : '上传 Markdown / TXT'}</span>
            <input
              type="file"
              accept={DOCUMENT_ACCEPT}
              disabled={uploading}
              onChange={onFileSelected}
            />
          </label>
        )}
        <button type="button" onClick={onRefresh} disabled={uploading}>刷新文档</button>
        {canWrite && (
          <button type="button" onClick={onDelete} disabled={uploading}>删除</button>
        )}
      </div>

      {uploadState && (
        <p
          className={`knowledge-upload-feedback is-${uploadState.kind}`}
          role={uploadState.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {uploadState.message}
        </p>
      )}

      <section className="knowledge-document-list" aria-label={`${base.name}的文档`}>
        <h3>文档</h3>
        {documentLoadError ? (
          <p className="knowledge-document-error" role="alert">{documentLoadError}</p>
        ) : documents === undefined ? (
          <p>正在加载文档…</p>
        ) : documents.length === 0 ? (
          <p>暂无文档，请从上方选择 Markdown 或 TXT 文件。</p>
        ) : (
          <ul>
            {documents.map((document) => (
              <li key={document.id}>
                <span>{document.name}</span>
                <span className={`knowledge-document-status is-${document.status ?? 'unknown'}`}>
                  {documentStatusLabel(document.status)}
                </span>
                {(document.errorMessage ?? document.error_message) && (
                  <span className="knowledge-document-error">
                    {document.errorMessage ?? document.error_message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

export function KnowledgeManager() {
  const { user } = useAuth();
  const canCreate = user?.role === 'admin' || user?.role === 'owner';
  const canWriteBase = (base: KnowledgeBase) =>
    user?.role === 'admin' || (user != null && base.owner_user_id === user.id);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<Record<string, KnowledgeDocument[]>>({});
  const [documentLoadErrors, setDocumentLoadErrors] = useState<Record<string, string>>({});
  const [uploadStates, setUploadStates] = useState<Record<string, UploadState>>({});
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const activeUploads = useRef(new Set<string>());

  const refreshDocuments = useCallback(async (kbId: string) => {
    try {
      const nextDocuments = await fetchKnowledgeDocuments(kbId);
      setDocuments((current) => ({ ...current, [kbId]: nextDocuments }));
      setDocumentLoadErrors((current) => {
        if (!(kbId in current)) return current;
        const next = { ...current };
        delete next[kbId];
        return next;
      });
    } catch (error) {
      setDocumentLoadErrors((current) => ({
        ...current,
        [kbId]: DOCUMENT_LOAD_ERROR,
      }));
      throw error;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const nextBases = await fetchKnowledgeBases();
      setBases(nextBases);
      const result = await loadKnowledgeDocumentLists(nextBases, fetchKnowledgeDocuments);
      setDocuments(result.documents);
      setDocumentLoadErrors(result.errors);
      setError(null);
    } catch {
      setError('知识库加载失败，请重试');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchKnowledgeBases(controller.signal)
      .then((nextBases) => {
        setBases(nextBases);
        setError(null);
        return loadKnowledgeDocumentLists(
          nextBases,
          (kbId) => fetchKnowledgeDocuments(kbId, controller.signal),
        );
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        setDocuments(result.documents);
        setDocumentLoadErrors(result.errors);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('知识库加载失败，请重试');
        }
      });
    return () => controller.abort();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      setError(null);
      await createKnowledgeBase({ name: name.trim() });
      setName('');
      await refresh();
    } catch {
      setError('创建失败，请重试');
    }
  };

  const remove = async (kbId: string) => {
    try {
      setError(null);
      await deleteKnowledgeBase(kbId);
      await refresh();
    } catch {
      setError('删除失败，请重试');
    }
  };

  const selectFile = async (kbId: string, event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (!isAcceptedKnowledgeFile(file.name)) {
      setUploadStates((current) => ({
        ...current,
        [kbId]: { kind: 'error', message: '仅支持 .md、.markdown 和 .txt 文件，请重新选择。' },
      }));
      input.value = '';
      return;
    }
    if (!reserveKnowledgeUpload(activeUploads.current, kbId)) return;

    setUploadStates((current) => ({
      ...current,
      [kbId]: { kind: 'uploading', message: `正在上传 ${file.name}…` },
    }));
    try {
      const uploadState = await finishKnowledgeUpload(
        file.name,
        () => uploadKnowledgeDocument(kbId, file),
        () => refreshDocuments(kbId),
      );
      setUploadStates((current) => ({
        ...current,
        [kbId]: uploadState,
      }));
    } catch {
      setUploadStates((current) => ({
        ...current,
        [kbId]: { kind: 'error', message: `${file.name} 上传失败，请重试。` },
      }));
    } finally {
      activeUploads.current.delete(kbId);
      input.value = '';
    }
  };

  return (
    <main className="knowledge-page">
      <header className="knowledge-page-header">
        <div>
          <h1>知识库</h1>
          <p>管理可供 Agent 检索的 Markdown 与 TXT 文档。</p>
        </div>
        <UserMenu />
      </header>
      {canCreate && (
        <div className="knowledge-create">
          <label htmlFor="knowledge-base-name">新知识库名称</label>
          <input
            id="knowledge-base-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：产品文档"
          />
          <button type="button" onClick={() => void create()}>新建</button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="knowledge-grid">
        {bases.map((base) => (
          <KnowledgeBaseCard
            key={base.id}
            base={base}
            canWrite={canWriteBase(base)}
            documents={documents[base.id]}
            documentLoadError={documentLoadErrors[base.id]}
            uploadState={uploadStates[base.id]}
            onFileSelected={(event) => { void selectFile(base.id, event); }}
            onDelete={() => { void remove(base.id); }}
            onRefresh={() => {
              void refreshDocuments(base.id).catch(() => undefined);
            }}
          />
        ))}
      </div>
    </main>
  );
}

export {
  KnowledgeBaseCard,
  finishKnowledgeUpload,
  isAcceptedKnowledgeFile,
  loadKnowledgeDocumentLists,
  reserveKnowledgeUpload,
};
