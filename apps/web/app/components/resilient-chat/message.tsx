import { AIBoundary } from '@cognicatch/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { triggerAttachmentDownload } from './lightbox';
import { Icon } from './icon';
import { messageText } from './utils';
import type { AgentTodo, InsightCard, ResilientMessage } from './types';
import { CitationList } from './citation-list';

function Message({
  copied,
  dismissedCards,
  header,
  liveLabel,
  message,
  onBoundaryError,
  onCopy,
  onDismissCard,
  onPreviewImage,
  reasoning,
  runTokens,
  showWaitingDots,
  streaming,
}: {
  copied: boolean;
  dismissedCards: Set<string>;
  /** 本轮执行面板：放在正文上方、与消息正文同列（不高于头像）。 */
  header?: ReactNode;
  /** 流式生成但还没有正文时，气泡内实时展示的当前动作/思考。 */
  liveLabel: string | null;
  message: ResilientMessage;
  onBoundaryError: () => void;
  onCopy: (id: string, text: string) => Promise<void>;
  onDismissCard: (id: string) => void;
  /** 点击聊天图片时在当前页弹出大图（输入框缩略图与历史消息共用）。 */
  onPreviewImage: (url: string, filename?: string) => void;
  /** 模型思考过程（reasoning_content），按 runId 独立存储，持久化保留。 */
  reasoning: string;
  /** 本轮运行结束后的 token 用量，展示在最后一条 assistant 消息的复制按钮后。 */
  runTokens: number;
  /** 执行面板可见时不再重复显示三点 loading（面板头部自带 spinner）。 */
  showWaitingDots: boolean;
  streaming: boolean;
}) {
  const text = messageText(message);
  const isUser = message.role === 'user';
  const cards = message.parts.filter((part) => part.type === 'data-card');
  const fileParts = isUser
    ? message.parts.filter((part) => part.type === 'file')
    : [];
  const citations = message.parts.filter((part) => part.type === 'data-citations').flatMap((part) => {
    const data = part.data as { citations?: import('./types').Citation[] };
    return data.citations ?? [];
  });
  // 思考过程自动滚动到底部
  const thinkingBodyRef = useRef<HTMLDivElement>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  useEffect(() => {
    if (thinkingBodyRef.current) {
      thinkingBodyRef.current.scrollTop = thinkingBodyRef.current.scrollHeight;
    }
  }, [reasoning]);

  return (
    <article className={`message-row ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="avatar">
        <Icon name={isUser ? 'user' : 'shield'} size={17} />
      </div>
      <div className="message-body">
        {!isUser && message.metadata?.model && (
          <div className="message-meta">
            <span>{message.metadata.model}</span>
          </div>
        )}
        {!isUser && reasoning && (
          <div className={`thinking-chain ${thinkingExpanded ? 'is-expanded' : ''}`}>
            <button
              type="button"
              className="thinking-chain-header"
              onClick={() => setThinkingExpanded((v) => !v)}
            >
              <span className="thinking-chain-bullet" />
              <span className="thinking-chain-title">
                {text ? '思考过程' : '思考中'}
                {!text && <StreamingDots />}
              </span>
              <span className="thinking-chain-toggle">
                {thinkingExpanded ? '收起' : '展开'}
              </span>
            </button>
            <div className="thinking-chain-body" ref={thinkingBodyRef}>
              <div className="thinking-chain-content">{reasoning}</div>
            </div>
          </div>
        )}
        {header}
        {isUser && fileParts.length > 0 && (
          <div className="message-attachments">
            {fileParts.map((part, index) =>
              part.mediaType.startsWith('image/') ? (
                <button
                  type="button"
                  className="message-attachment-image"
                  key={`${message.id}-file-${index}`}
                  onClick={() => onPreviewImage(part.url, part.filename)}
                  title={part.filename ? `查看大图：${part.filename}` : '查看大图'}
                >
                  <img alt={part.filename ?? '聊天图片'} src={part.url} />
                </button>
              ) : (
                <button
                  type="button"
                  className="message-attachment-file"
                  key={`${message.id}-file-${index}`}
                  title={part.filename ? `下载附件：${part.filename}` : '下载附件'}
                  onClick={async () => {
                    try {
                      await triggerAttachmentDownload(part.url, part.filename);
                    } catch {
                      /* 下载失败静默；用户可重试或点击浏览器 Network 排查 401/404 */
                    }
                  }}
                >
                  <Icon name="paperclip" size={14} />
                  {part.filename ?? '附件'}
                </button>
              ),
            )}
          </div>
        )}
        <div className={`message-copy ${isUser ? '' : 'markdown-content'}`}>
          {text ? (
            isUser ? (
              text
            ) : (
              <MarkdownContent content={text} onPreviewImage={onPreviewImage} />
            )
          ) : streaming && showWaitingDots ? (
            <span className="streaming-live">
              <StreamingDots />
              {liveLabel && (
                <span className="streaming-live-text">{liveLabel}</span>
              )}
            </span>
          ) : (
            !isUser && !streaming && (
              <p className="message-empty">本轮没有返回任何内容，可以重新发送这条消息。</p>
            )
          )}
        </div>

        {!isUser && !dismissedCards.has(message.id) &&
          cards.map((part, index) =>
            part.data ? (
              <AIBoundary
                key={`${message.id}-card-${index}`}
                mode="manual"
                title="AI 组件渲染失败"
                description="模型返回了无效的组件结构，已安全降级；聊天内容不受影响。"
                rawPayload={part.data}
                showRawData={false}
                onError={onBoundaryError}
                onReset={() => onDismissCard(message.id)}
              >
                <GeneratedInsightCard data={part.data} />
              </AIBoundary>
            ) : null,
          )}

        {!isUser && <CitationList citations={citations} />}

        {!isUser && text && !streaming && (
          <div className="message-actions">
            <button
              type="button"
              onClick={() => void onCopy(message.id, text)}
            >
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? '已复制' : '复制'}
            </button>
            {runTokens > 0 && (
              <span className="message-tokens">
                <span className="tokens-dot" aria-hidden="true" />
                本次运行已生成约 {runTokens.toLocaleString('zh-CN')} tokens
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function GeneratedInsightCard({ data }: { data: InsightCard }) {
  if (data.kind !== 'reliability-summary') {
    return null;
  }

  return (
    <section className="insight-card" aria-label={data.title}>
      <div>
        <span>{data.eyebrow}</span>
        <h3>{data.title}</h3>
        <p>{data.body}</p>
      </div>
      <div className="insight-metric">
        <strong>{data.metric}</strong>
        <small>{data.metric_label}</small>
      </div>
    </section>
  );
}

/**
 * 校验大模型返回的链接是否安全：只允许 http/https/mailto 协议，
 * 拒绝 javascript:/data:/vbscript: 等可执行或可注入的危险协议。
 * 通过后才渲染为可点击链接，否则降级为纯文本。
 */
function safeExternalUrl(href: string | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
    return href;
  }
  return null;
}

function MarkdownContent({
  content,
  onPreviewImage,
}: {
  content: string;
  onPreviewImage: (url: string, filename?: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => {
          const safe = safeExternalUrl(href);
          if (!safe) {
            // 危险链接降级为纯文本，避免 javascript: 等协议在本站上下文执行。
            return <span>{children}</span>;
          }
          return (
            <a
              href={safe}
              // noopener：新标签页无法通过 window.opener 反向操作本页；
              // noreferrer：不发送 Referer 头，避免泄露当前页面 URL。
              // 二者共同确保跳转不携带本站点的任何上下文信息。
              rel="noopener noreferrer"
              target="_blank"
            >
              {children}
            </a>
          );
        },
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
        img: ({ src, alt }) => {
          if (!src) return null;
          const url = typeof src === 'string' ? src : URL.createObjectURL(src);
          return (
            <img
              src={url}
              alt={alt ?? ''}
              loading="lazy"
              onClick={() => onPreviewImage(url, alt ?? undefined)}
            />
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function StreamingDots() {
  return (
    <span className="streaming-dots" role="status">
      <span className="sr-only">正在生成</span>
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </span>
  );
}

function ThinkingRow({ children }: { children?: ReactNode }) {
  return (
    <article className="message-row is-assistant thinking-row">
      <div className="avatar">
        <Icon name="shield" size={17} />
      </div>
      <div className="message-body">
        {children ?? <StreamingDots />}
      </div>
    </article>
  );
}

function AgentTodoList({ todos }: { todos: AgentTodo[] }) {
  const [open, setOpen] = useState(false);
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.find((todo) => todo.status === 'in_progress');

  return (
    <section className="task-bar" aria-label="Agent 任务计划">
      <button
        aria-expanded={open}
        className="task-bar-head"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="list" size={15} />
        <span className="task-bar-count">
          {completed}/{todos.length} 个任务已完成
        </span>
        {active && !open && (
          <span className="task-bar-current">{active.content}</span>
        )}
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <ol className="task-bar-list">
          {todos.map((todo, index) => (
            <li className={`is-${todo.status}`} key={`${index}-${todo.content}`}>
              <span>
                {todo.status === 'completed' ? (
                  <Icon name="check" size={12} />
                ) : todo.status === 'in_progress' ? (
                  <span className="pulse-dot" />
                ) : (
                  index + 1
                )}
              </span>
              {todo.content}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export {
  AgentTodoList,
  GeneratedInsightCard,
  MarkdownContent,
  Message,
  StreamingDots,
  ThinkingRow,
};
