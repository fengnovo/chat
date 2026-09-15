import type { FileUIPart } from 'ai';
import { useEffect, useRef, useState, type FormEvent } from 'react';

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
// 图片走多模态视觉识别；文本类文件由后端解码后内联进消息正文。
const ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,text/*,.txt,.md,.markdown,.json,.csv,.log,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.py';

interface PendingAttachment {
  id: string;
  file: File;
  mediaType: string;
  dataUrl: string;
  isImage: boolean;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
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
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>, files: FileUIPart[]) => void;
  onSuggestion: (suggestion: string) => Promise<void>;
  onToggleKnowledgeBase: (id: string) => void;
  suggestions: string[];
  todos: AgentTodo[];
}) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const locked = disabled || isBusy;
  const canSend = !locked && (input.trim().length > 0 || pending.length > 0);

  useEffect(() => {
    if (!attachError) return;
    const timer = window.setTimeout(() => setAttachError(null), 3200);
    return () => window.clearTimeout(timer);
  }, [attachError]);

  async function addFiles(fileList: FileList | null) {
    const incoming = Array.from(fileList ?? []);
    if (incoming.length === 0) return;
    if (pending.length + incoming.length > MAX_ATTACHMENTS) {
      setAttachError(`最多上传 ${MAX_ATTACHMENTS} 个文件`);
      return;
    }
    const next: PendingAttachment[] = [];
    for (const file of incoming) {
      const mediaType = file.type || 'application/octet-stream';
      const isImage = mediaType.startsWith('image/');
      if (isImage && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)) {
        setAttachError('图片仅支持 PNG / JPEG / GIF / WebP');
        return;
      }
      if (!isImage && !mediaType.startsWith('text/')) {
        setAttachError('暂不支持该文件类型，可上传图片或文本类文件');
        return;
      }
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
      if (file.size > limit) {
        setAttachError(
          isImage ? '图片不能超过 10MB' : '文本文件不能超过 200KB',
        );
        return;
      }
      try {
        const dataUrl = await readAsDataUrl(file);
        next.push({
          id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          mediaType,
          dataUrl,
          isImage,
        });
      } catch {
        setAttachError(`读取文件失败：${file.name}`);
        return;
      }
    }
    setPending((current) => [...current, ...next]);
    setAttachError(null);
  }

  function removeAttachment(id: string) {
    setPending((current) => current.filter((item) => item.id !== id));
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || (!input.trim() && pending.length === 0)) return;
    const files: FileUIPart[] = pending.map((item) => ({
      type: 'file',
      mediaType: item.mediaType,
      filename: item.file.name,
      url: item.dataUrl,
    }));
    // 先快照附件再清空：父组件只消费 files，不清空会导致下一轮重复发送。
    setPending([]);
    setAttachError(null);
    onSubmit(event, files);
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
              <div className="composer-attachment" key={item.id}>
                {item.isImage ? (
                  <img
                    alt={item.file.name}
                    className="composer-attachment-thumb"
                    src={item.dataUrl}
                  />
                ) : (
                  <span className="composer-attachment-file">
                    <Icon name="paperclip" size={15} />
                    <span className="composer-attachment-name" title={item.file.name}>
                      {item.file.name}
                    </span>
                  </span>
                )}
                <button
                  aria-label={`移除附件 ${item.file.name}`}
                  className="composer-attachment-remove"
                  disabled={locked}
                  type="button"
                  onClick={() => removeAttachment(item.id)}
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
            accept={ACCEPT}
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
              aria-label="发送消息"
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
