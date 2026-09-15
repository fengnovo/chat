'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';

import {
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  renameKnowledgeDocument,
  uploadKnowledgeDocument,
  type KnowledgeBase,
  type KnowledgeDocument,
} from './knowledge-api';
import {
  DOCUMENT_ACCEPT,
  documentStatusLabel,
  documentStatusTone,
  finishKnowledgeUpload,
  formatDateTime,
  isAcceptedKnowledgeFile,
  isDocumentBusy,
  reserveKnowledgeUpload,
  type UploadState,
} from './knowledge-helpers';
import {
  Badge,
  DocIcon,
  EditIcon,
  EmptyState,
  LayersIcon,
  Modal,
  SearchIcon,
  Spinner,
  TrashIcon,
  UploadIcon,
} from './knowledge-ui';

const ACTIVE_INDEX_STATUSES = new Set(['pending', 'queued', 'indexing', 'processing']);

export function DocumentsView({
  kb,
  canWrite,
  onViewChunks,
  onChanged,
}: {
  kb: KnowledgeBase;
  canWrite: boolean;
  onViewChunks: (documentId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [renaming, setRenaming] = useState<KnowledgeDocument | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUploads = useRef(new Set<string>());

  const refresh = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const next = await listKnowledgeDocuments(kb.id);
      setDocuments(next);
      setLoadError(null);
    } catch {
      setLoadError('文档加载失败，请稍后重试。');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [kb.id]);

  useEffect(() => {
    setDocuments([]);
    setSearch('');
    setConfirmDeleteId(null);
    setUploadState(null);
    void refresh();
  }, [refresh]);

  // 索引进行中时轮询文档状态，处理完成后同步刷新知识库统计。
  useEffect(() => {
    const busy = documents.some((document) => ACTIVE_INDEX_STATUSES.has(document.status));
    if (!busy) return;
    const timer = setInterval(() => { void refresh(true); }, 4_000);
    return () => clearInterval(timer);
  }, [documents, refresh]);

  const selectFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    for (const file of files) {
      if (!isAcceptedKnowledgeFile(file.name)) {
        setUploadState({ kind: 'error', message: `${file.name} 不是受支持的 Markdown / TXT 文件，已跳过。` });
        continue;
      }
      if (!reserveKnowledgeUpload(activeUploads.current, kb.id)) {
        setUploadState({ kind: 'error', message: '该知识库已有上传任务进行中，请稍候。' });
        continue;
      }
      setUploadState({ kind: 'uploading', message: `正在上传 ${file.name}…` });
      try {
        const state = await finishKnowledgeUpload(
          file.name,
          () => uploadKnowledgeDocument(kb.id, file),
          async () => { await refresh(true); },
        );
        setUploadState(state);
        await onChanged();
      } catch (caught) {
        setUploadState({
          kind: 'error',
          message:
            caught instanceof Error && caught.message
              ? `${file.name}：${caught.message}`
              : `${file.name} 上传失败，请重试。`,
        });
      } finally {
        activeUploads.current.delete(kb.id);
      }
    }
    input.value = '';
  };

  const submitRename = async (name: string) => {
    if (!renaming) return;
    try {
      await renameKnowledgeDocument(kb.id, renaming.id, name);
      setRenaming(null);
      await refresh(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '重命名失败');
    }
  };

  const remove = async (document: KnowledgeDocument) => {
    try {
      await deleteKnowledgeDocument(kb.id, document.id);
      setConfirmDeleteId(null);
      await Promise.all([refresh(true), onChanged()]);
    } catch {
      setActionError('删除失败，请重试');
    }
  };

  const filtered = documents.filter((document) =>
    document.name.toLowerCase().includes(search.trim().toLowerCase()) ||
    document.id.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="kc-view">
      <div className="kc-toolbar">
        {canWrite && (
          <>
            <button type="button" className="kc-button kc-button-primary" onClick={() => fileInputRef.current?.click()}>
              <UploadIcon /> 上传文档
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={DOCUMENT_ACCEPT}
              multiple
              hidden
              onChange={(event) => { void selectFiles(event); }}
            />
          </>
        )}
        <span className="kc-count">共 {documents.length} 个文档</span>
        <div className="kc-search">
          <SearchIcon />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索文档名称 / ID"
            aria-label="搜索文档"
          />
        </div>
      </div>

      {uploadState && (
        <p className={`kc-alert kc-alert-${uploadState.kind}`} role={uploadState.kind === 'error' ? 'alert' : 'status'}>
          {uploadState.message}
        </p>
      )}
      {actionError && <p className="kc-alert kc-alert-error" role="alert">{actionError}</p>}
      {loadError && <p className="kc-alert kc-alert-error" role="alert">{loadError}</p>}

      {loading ? (
        <div className="kc-loading"><Spinner /> 正在加载文档…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<DocIcon />}
          title={documents.length === 0 ? '该知识库还没有文档' : '没有匹配的文档'}
          hint={documents.length === 0 && canWrite ? '上传 Markdown 或 TXT 文档，索引完成后即可检索。' : undefined}
        />
      ) : (
        <div className="kc-table-wrap">
          <table className="kc-table">
            <thead>
              <tr>
                <th>文档名称 / ID</th>
                <th className="kc-col-center">文档状态</th>
                <th className="kc-col-center">处理策略</th>
                <th className="kc-col-center">切片数</th>
                <th className="kc-col-center">导入方式</th>
                <th className="kc-col-center">更新时间</th>
                <th className="kc-col-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((document) => (
                <tr key={document.id}>
                  <td>
                    <div className="kc-doc-cell">
                      <span className="kc-doc-icon"><DocIcon /></span>
                      <div className="kc-doc-meta">
                        <span className="kc-doc-name" title={document.name}>{document.name}</span>
                        <span className="kc-doc-id" title={document.id}>{document.id}</span>
                      </div>
                    </div>
                  </td>
                  <td className="kc-col-center">
                    <Badge tone={documentStatusTone(document.status)}>
                      {isDocumentBusy(document.status) && <span className="kc-badge-dot" />}
                      {documentStatusLabel(document.status)}
                    </Badge>
                    {document.errorMessage && (
                      <span className="kc-row-error" title={document.errorMessage}>{document.errorMessage}</span>
                    )}
                  </td>
                  <td className="kc-col-center">
                    <span className="kc-muted" title={`切片大小 ${kb.chunkSize}，重叠 ${kb.chunkOverlap}`}>自动切片</span>
                  </td>
                  <td className="kc-col-center">{document.status === 'ready' ? document.chunkCount : '—'}</td>
                  <td className="kc-col-center"><span className="kc-muted">本地上传</span></td>
                  <td className="kc-col-center kc-muted">{formatDateTime(document.updatedAt)}</td>
                  <td className="kc-col-right">
                    <div className="kc-row-actions">
                      <button
                        type="button"
                        className="kc-link-button"
                        disabled={document.status !== 'ready' || document.chunkCount === 0}
                        onClick={() => onViewChunks(document.id)}
                      >
                        <LayersIcon /> 切片详情
                      </button>
                      {canWrite && (
                        <>
                          <button type="button" className="kc-link-button" onClick={() => { setActionError(null); setRenaming(document); }}>
                            <EditIcon /> 重命名
                          </button>
                          {confirmDeleteId === document.id ? (
                            <button type="button" className="kc-link-button kc-link-danger" onClick={() => void remove(document)}>
                              确认删除？
                            </button>
                          ) : (
                            <button type="button" className="kc-link-button kc-link-danger" onClick={() => { setActionError(null); setConfirmDeleteId(document.id); }}>
                              <TrashIcon /> 删除
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {renaming && (
        <RenameDocumentModal
          document={renaming}
          busy={false}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => { void submitRename(name); }}
        />
      )}
    </div>
  );
}

function RenameDocumentModal({
  document,
  busy,
  onCancel,
  onSubmit,
}: {
  document: KnowledgeDocument;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(document.name);
  return (
    <Modal
      title="重命名文档"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="kc-button" onClick={onCancel} disabled={busy}>取消</button>
          <button
            type="button"
            className="kc-button kc-button-primary"
            disabled={busy || !name.trim() || name.trim() === document.name}
            onClick={() => onSubmit(name.trim())}
          >
            保存
          </button>
        </>
      }
    >
      <p className="kc-form-hint">仅修改文档展示名称，不会重新触发索引，也不影响切片内容。</p>
      <input
        className="kc-text-input"
        value={name}
        maxLength={255}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
    </Modal>
  );
}
