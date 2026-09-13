import { AIBoundary } from '@cognicatch/react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Icon } from './icon';
import { messageText } from './utils';
import type { AgentTodo, InsightCard, ResilientMessage } from './types';
import { CitationList } from './citation-list';

function Message({
  copied,
  dismissedCards,
  liveLabel,
  message,
  onBoundaryError,
  onCopy,
  onDismissCard,
  streaming,
}: {
  copied: boolean;
  dismissedCards: Set<string>;
  /** 流式生成但还没有正文时，气泡内实时展示的当前动作/思考。 */
  liveLabel: string | null;
  message: ResilientMessage;
  onBoundaryError: () => void;
  onCopy: (id: string, text: string) => Promise<void>;
  onDismissCard: (id: string) => void;
  streaming: boolean;
}) {
  const text = messageText(message);
  const cards = message.parts.filter((part) => part.type === 'data-card');
  const citations = message.parts.filter((part) => part.type === 'data-citations').flatMap((part) => {
    const data = part.data as { citations?: import('./types').Citation[] };
    return data.citations ?? [];
  });
  const isUser = message.role === 'user';

  return (
    <article className={`message-row ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="avatar">
        <Icon name={isUser ? 'user' : 'shield'} size={17} />
      </div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{isUser ? '你' : 'Coding Agent'}</strong>
          {!isUser && message.metadata?.model && (
            <span>{message.metadata.model}</span>
          )}
        </div>
        <div className={`message-copy ${isUser ? '' : 'markdown-content'}`}>
          {text ? (
            isUser ? (
              text
            ) : (
              <MarkdownContent content={text} />
            )
          ) : streaming ? (
            <span className="streaming-live">
              <StreamingDots />
              {liveLabel && (
                <span className="streaming-live-text">{liveLabel}</span>
              )}
            </span>
          ) : (
            <p className="message-empty">本轮没有返回任何内容，可以重新发送这条消息。</p>
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

        {!isUser && text && (
          <div className="message-actions">
            <button
              type="button"
              onClick={() => void onCopy(message.id, text)}
            >
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? '已复制' : '复制'}
            </button>
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

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} rel="noreferrer" target="_blank">
            {children}
          </a>
        ),
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
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

function ThinkingRow() {
  return (
    <article className="message-row is-assistant thinking-row">
      <div className="avatar">
        <Icon name="shield" size={17} />
      </div>
      <div className="message-body">
        <div className="message-meta">
          <strong>Coding Agent</strong>
          <span>正在等待 Worker 启动</span>
        </div>
        <StreamingDots />
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
