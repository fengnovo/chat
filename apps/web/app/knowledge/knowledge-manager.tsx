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

const DOCUMENT_ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';

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

function documentStatusLabel(status?: string) {
  if (status === 'ready') return '可检索';
  if (status === 'failed') return '处理失败';
  if (status === 'pending') return '等待上传';
  if (status === 'queued') return '等待索引';
  return status ?? '状态未知';
}

type KnowledgeBaseCardProps = {
  base: KnowledgeBase;
  documents?: KnowledgeDocument[];
  uploadState?: UploadState;
  onFileSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onDelete: () => void;
  onRefresh: () => void;
};

function KnowledgeBaseCard({
  base,
  documents,
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
        <label className="knowledge-upload-control">
          <span>{uploading ? '上传 Markdown / TXT（上传中…）' : '上传 Markdown / TXT'}</span>
          <input
            type="file"
            accept={DOCUMENT_ACCEPT}
            disabled={uploading}
            onChange={onFileSelected}
          />
        </label>
        <button type="button" onClick={onRefresh} disabled={uploading}>刷新文档</button>
        <button type="button" onClick={onDelete} disabled={uploading}>删除</button>
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
        {documents === undefined ? (
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
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<Record<string, KnowledgeDocument[]>>({});
  const [uploadStates, setUploadStates] = useState<Record<string, UploadState>>({});
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const activeUploads = useRef(new Set<string>());

  const refreshDocuments = useCallback(async (kbId: string) => {
    const nextDocuments = await fetchKnowledgeDocuments(kbId);
    setDocuments((current) => ({ ...current, [kbId]: nextDocuments }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const nextBases = await fetchKnowledgeBases();
      setBases(nextBases);
      const entries = await Promise.all(nextBases.map(async (base) => (
        [base.id, await fetchKnowledgeDocuments(base.id)] as const
      )));
      setDocuments(Object.fromEntries(entries));
      setError(null);
    } catch {
      setError('知识库或文档列表加载失败，请重试');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchKnowledgeBases(controller.signal)
      .then(async (nextBases) => ({
        nextBases,
        entries: await Promise.all(nextBases.map(async (base) => (
          [base.id, await fetchKnowledgeDocuments(base.id, controller.signal)] as const
        ))),
      }))
      .then(({ nextBases, entries }) => {
        setBases(nextBases);
        setDocuments(Object.fromEntries(entries));
        setError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('知识库或文档列表加载失败，请重试');
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
      await uploadKnowledgeDocument(kbId, file);
      await refreshDocuments(kbId);
      setUploadStates((current) => ({
        ...current,
        [kbId]: { kind: 'success', message: `${file.name} 已上传，正在等待索引。` },
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
      <header>
        <h1>知识库</h1>
        <p>管理可供 Agent 检索的 Markdown 与 TXT 文档。</p>
      </header>
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
      {error && <p role="alert">{error}</p>}
      <div className="knowledge-grid">
        {bases.map((base) => (
          <KnowledgeBaseCard
            key={base.id}
            base={base}
            documents={documents[base.id]}
            uploadState={uploadStates[base.id]}
            onFileSelected={(event) => { void selectFile(base.id, event); }}
            onDelete={() => { void remove(base.id); }}
            onRefresh={() => {
              void refreshDocuments(base.id).catch(() => {
                setUploadStates((current) => ({
                  ...current,
                  [base.id]: { kind: 'error', message: '文档列表刷新失败，请重试。' },
                }));
              });
            }}
          />
        ))}
      </div>
    </main>
  );
}

export { KnowledgeBaseCard, isAcceptedKnowledgeFile, reserveKnowledgeUpload };
