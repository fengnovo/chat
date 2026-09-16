import type { FileUIPart } from 'ai';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  deleteChatAttachment,
  uploadChatAttachment,
  type ChatAttachmentView,
} from './attachments-api';
import { Icon } from './icon';
import {
  KnowledgeBaseMenu,
  type KnowledgeBase,
} from './knowledge-base-picker';
import { AgentTodoList } from './message';
import type { AgentTodo } from './types';

const MAX_ATTACHMENTS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// 浏览器对 .md/.csv 等常给空 MIME，按扩展名兜底识别文本。
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'jsx', 'py', 'sh', 'sql', 'ini', 'conf', 'toml',
]);

type AttachmentStatus = 'uploading' | 'ready' | 'error';

interface PendingAttachment {
  localId: string;
  file: File;
  mediaType: string;
  isImage: boolean;
  /** 本地预览地址（blob:），不走网络；发送后释放。 */
  previewUrl: string;
  status: AttachmentStatus;
  attachment?: ChatAttachmentView;
  errorMessage?: string;
}

function validateFile(file: File, mediaType: string, isImage: boolean): string | null {
  if (isImage) {
    if (!IMAGE_TYPES.includes(mediaType)) return '图片仅支持 PNG / JPEG / GIF / WebP';
    if (file.size > MAX_IMAGE_BYTES) return '图片不能超过 10MB';
    return null;
  }
  const extension = file.name.includes('.')
    ? file.name.split('.').pop()!.toLowerCase()
    : '';
  const isText = mediaType.startsWith('text/') || TEXT_EXTENSIONS.has(extension);
  if (isText && file.size > MAX_TEXT_BYTES) return '文本文件不能超过 200KB';
  if (!isText && file.size > MAX_FILE_BYTES) return '文件不能超过 50MB';
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function Composer({
  activity,
  disabled,
  disabledPlaceholder,
  input,
  isBusy,
  knowledgeBases,
  knowledgeBaseIds,
  onChange,
  onChangeKnowledgeBases,
  onPreviewImage,
  onStop,
  onSubmit,
  onSuggestion,
  onToggleKnowledgeBase,
  suggestions,
  todos,
}: {
  activity: string | null;
  disabled: boolean;
  disabledPlaceholder: string;
  input: string;
  isBusy: boolean;
  knowledgeBases: KnowledgeBase[];
  knowledgeBaseIds: string[];
  onChange: (value: string) => void;
  onChangeKnowledgeBases: (ids: string[]) => void;
  /** 点击图片缩略图时在当前页弹出大图。 */
  onPreviewImage: (url: string, filename?: string) => void;
  onStop: () => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    files: FileUIPart[],
    attachmentIds: string[],
  ) => void;
  onSuggestion: (suggestion: string) => Promise<void>;
  onToggleKnowledgeBase: (id: string) => void;
  suggestions: string[];
  todos: AgentTodo[];
}) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 卸载后不再 setState；所有 blob URL 统一在清理时释放。
  const mountedRef = useRef(true);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const locked = disabled || isBusy;
  const hasUploading = pending.some((item) => item.status === 'uploading');
  const canSend =
    !locked &&
    !hasUploading &&
    (input.trim().length > 0 || pending.some((item) => item.status === 'ready'));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!attachError) return;
    const timer = window.setTimeout(() => setAttachError(null), 3200);
    return () => window.clearTimeout(timer);
  }, [attachError]);

  function patchAttachment(localId: string, patch: Partial<PendingAttachment>) {
    if (!mountedRef.current) return;
    setPending((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  }

  async function startUpload(localId: string, file: File) {
    try {
      const attachment = await uploadChatAttachment(file);
      if (!mountedRef.current) {
        // 页面已卸载：附件没人会发送，尽量回收服务端暂存记录。
        await deleteChatAttachment(attachment.id).catch(() => undefined);
        return;
      }
      patchAttachment(localId, { status: 'ready', attachment, errorMessage: undefined });
    } catch (error) {
      patchAttachment(localId, {
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '上传失败',
      });
    }
  }

  function addFiles(fileList: FileList | null) {
    const incoming = Array.from(fileList ?? []);
    if (incoming.length === 0) return;
    if (pending.length + incoming.length > MAX_ATTACHMENTS) {
      setAttachError(`最多上传 ${MAX_ATTACHMENTS} 个文件`);
      return;
    }
    const next: PendingAttachment[] = [];
    for (const file of incoming) {
      const mediaType = file.type || 'application/octet-stream';
      const isImage = IMAGE_TYPES.includes(mediaType);
      const validationError = validateFile(file, mediaType, isImage);
      if (validationError) {
        setAttachError(validationError);
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      previewUrlsRef.current.add(previewUrl);
      const item: PendingAttachment = {
        localId: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        mediaType,
        isImage,
        previewUrl,
        status: 'uploading',
      };
      next.push(item);
    }
    setPending((current) => [...current, ...next]);
    setAttachError(null);
    // 选中即传：不等待上传完成，用户继续打字；发送按钮在全部 ready 前保持置灰。
    for (const item of next) void startUpload(item.localId, item.file);
  }

  function retryUpload(localId: string) {
    const item = pending.find((candidate) => candidate.localId === localId);
    if (!item || item.status === 'uploading') return;
    patchAttachment(localId, { status: 'uploading', errorMessage: undefined });
    void startUpload(localId, item.file);
  }

  function removeAttachment(localId: string) {
    const item = pending.find((candidate) => candidate.localId === localId);
    if (!item) return;
    URL.revokeObjectURL(item.previewUrl);
    previewUrlsRef.current.delete(item.previewUrl);
    setPending((current) => current.filter((candidate) => candidate.localId !== localId));
    if (item.attachment) {
      void deleteChatAttachment(item.attachment.id).catch(() => undefined);
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ready = pending.filter((item) => item.status === 'ready' && item.attachment);
    if (locked || hasUploading || (!input.trim() && ready.length === 0)) return;
    const files: FileUIPart[] = ready.map((item) => ({
      type: 'file',
      mediaType: item.mediaType,
      filename: item.file.name,
      // 供本地气泡与历史还原渲染；真正发给模型的是 attachment_ids 引用。
      url: item.attachment!.url,
    }));
    const attachmentIds = ready.map((item) => item.attachment!.id);
    // 先快照附件再清空：父组件只消费 files/id，不清空会导致下一轮重复发送。
    for (const item of ready) {
      URL.revokeObjectURL(item.previewUrl);
      previewUrlsRef.current.delete(item.previewUrl);
    }
    setPending([]);
    setAttachError(null);
    onSubmit(event, files, attachmentIds);
  }

  return (
    <div className="composer-wrap">
      {todos.length > 0 && <AgentTodoList todos={todos} />}
      {activity && (
        <div className="composer-activity" role="status" aria-live="polite">
          <span className="activity-spinner" aria-hidden="true" />
          <span>{activity}</span>
        </div>
      )}
      {suggestions.length > 0 && !isBusy && !disabled && (
        <div className="suggestions" aria-label="推荐问题">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void onSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={handleFormSubmit}>
        {pending.length > 0 && (
          <div className="composer-attachments" aria-label="待发送附件">
            {pending.map((item) => (
              <div
                className={`composer-attachment is-${item.status}`}
                key={item.localId}
                title={item.errorMessage ?? item.file.name}
              >
                {item.isImage ? (
                  <button
                    type="button"
                    className="composer-attachment-thumb-button"
                    onClick={() => onPreviewImage(item.previewUrl, item.file.name)}
                    aria-label={`预览图片 ${item.file.name}`}
                  >
                    <img
                      alt={item.file.name}
                      className="composer-attachment-thumb"
                      src={item.previewUrl}
                    />
                  </button>
                ) : (
                  <span className="composer-attachment-file">
                    <Icon name="paperclip" size={15} />
                    <span className="composer-attachment-name" title={item.file.name}>
                      {item.file.name}
                    </span>
                    <span className="composer-attachment-size">{formatSize(item.file.size)}</span>
                  </span>
                )}
                {item.status === 'uploading' && (
                  <span className="composer-attachment-overlay" aria-label="上传中">
                    <span className="activity-spinner" aria-hidden="true" />
                  </span>
                )}
                {item.status === 'error' && (
                  <span className="composer-attachment-overlay is-error">
                    <button
                      type="button"
                      className="composer-attachment-retry"
                      onClick={() => retryUpload(item.localId)}
                      title={item.errorMessage ?? '上传失败，点击重试'}
                    >
                      <Icon name="refresh" size={15} />
                      <span>重试</span>
                    </button>
                  </span>
                )}
                <button
                  aria-label={`移除附件 ${item.file.name}`}
                  className="composer-attachment-remove"
                  disabled={locked}
                  type="button"
                  onClick={() => removeAttachment(item.localId)}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <label className="sr-only" htmlFor="chat-input">
          输入消息
        </label>
        <textarea
          id="chat-input"
          rows={2}
          value={input}
          disabled={locked}
          placeholder={
            disabled ? disabledPlaceholder : '描述要在项目中完成的任务，可附带图片或文件…'
          }
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // 中文/日文输入法组词时 Enter 用于确认候选词（部分浏览器只给 keyCode 229），
            // 这时绝不能触发发送，否则英文单词没拼完就被提交了。
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {attachError && (
          <p className="composer-error" role="alert">
            {attachError}
          </p>
        )}
        <div className="composer-toolbar">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            className="composer-icon-button"
            disabled={locked || pending.length >= MAX_ATTACHMENTS}
            title={
              pending.length >= MAX_ATTACHMENTS
                ? `最多上传 ${MAX_ATTACHMENTS} 个文件`
                : '上传图片或文件（最多 5 个）'
            }
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="paperclip" size={18} />
          </button>
          {knowledgeBases.length > 0 && (
            <KnowledgeBaseMenu
              bases={knowledgeBases}
              value={knowledgeBaseIds}
              onToggle={onToggleKnowledgeBase}
              onChangeAll={onChangeKnowledgeBases}
            />
          )}
          {isBusy ? (
            <button
              className="send-button is-stop"
              type="button"
              aria-label="停止生成"
              onClick={onStop}
            >
              <Icon name="square" size={17} />
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              aria-label={hasUploading ? '附件上传中，请稍候' : '发送消息'}
              disabled={!canSend}
            >
              <Icon name="arrow" size={18} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export { Composer };
