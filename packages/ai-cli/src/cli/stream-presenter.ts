import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { Interrupt } from '@langchain/langgraph';
import type { HITLRequest } from 'langchain';

import {
  A,
  tuiEnterTask,
  tuiFinish,
  tuiLog,
  tuiResetTask,
  tuiSetActivity,
  tuiSetThinking,
  tuiSetTodos,
  tuiShowRecap,
  type Todo,
} from '../tui/index.js';
import type { UserQuestionRequest } from '../tui/types.js';

export type AgentInterruptRequest = HITLRequest | UserQuestionRequest;

export function isUserQuestionRequest(
  value: AgentInterruptRequest,
): value is UserQuestionRequest {
  return 'kind' in value && value.kind === 'ask_user';
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && 'text' in block
        ? String((block as { text: unknown }).text)
        : '',
    )
    .join('');
}

export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (name === 'execute') {
    return `${A.dim}$ ${String(args.command ?? '?')}${A.reset}`;
  }
  if (name === 'write_file' || name === 'edit_file') {
    const filePath = String(args.file_path ?? args.path ?? '?');
    const length = String(args.content ?? '').length;
    return `${A.dim}${filePath}（${length} 字符）${A.reset}`;
  }
  if (name === 'delete') {
    return `${A.dim}${String(args.file_path ?? args.path ?? JSON.stringify(args))}${A.reset}`;
  }
  const raw = JSON.stringify(args);
  return A.dim + (raw.length > 60 ? `${raw.slice(0, 60)}…` : raw) + A.reset;
}

/** 把 LangGraph values 快照转换为 TUI 更新，并负责消息去重。 */
export class StreamPresenter {
  private readonly seenMessageIds = new Set<string>();
  private lastAnswer = '';
  private activeModelMessageId = '';
  private modelOutputChars = 0;
  private modelToolName = '';
  private lastActivityRenderAt = 0;

  beginTask(userInput: string): void {
    tuiResetTask();
    tuiEnterTask();
    this.lastAnswer = '';
    this.resetModelActivity();
    tuiLog(`${A.dim}用户：${userInput.split('\n')[0].slice(0, 60)}${A.reset}`);
    tuiSetThinking(true);
  }

  showTrace(traceId: string): void {
    tuiLog(`${A.dim}🔭 LangSmith Trace ID：${traceId}${A.reset}`);
  }

  finish(): void {
    tuiFinish(this.lastAnswer || '（无回复）');
  }

  /** 消费 messages 模式的增量块，只展示进度，不提前渲染最终回复。 */
  ingestModelChunk(message: unknown): void {
    const chunk = message as {
      id?: string;
      content?: unknown;
      tool_call_chunks?: Array<{ name?: string; args?: string }>;
    };
    if (chunk.id && chunk.id !== this.activeModelMessageId) {
      this.resetModelActivity();
      this.activeModelMessageId = chunk.id;
    }

    const toolChunks = chunk.tool_call_chunks ?? [];
    const namedTool = toolChunks.find((toolChunk) => toolChunk.name)?.name;
    if (namedTool) this.modelToolName = namedTool;
    this.modelOutputChars +=
      textOf(chunk.content).length +
      toolChunks.reduce((total, toolChunk) => total + String(toolChunk.args ?? '').length, 0);

    const now = Date.now();
    const label = this.modelToolName
      ? `正在生成 ${this.modelToolName} 参数`
      : '正在生成模型回复';
    const labelChanged = namedTool !== undefined;
    if (labelChanged || now - this.lastActivityRenderAt >= 200) {
      this.lastActivityRenderAt = now;
      tuiSetActivity({ label, receivedChars: this.modelOutputChars, updatedAt: now });
    }
  }

  /** 消费 tools 模式的生命周期事件，让耗时工具不再显示成“模型思考”。 */
  ingestToolEvent(event: { event?: string; name?: string }): void {
    const name = event.name ?? '工具';
    if (event.event === 'on_tool_start') {
      tuiSetActivity({
        label: `正在执行 ${name}`,
        receivedChars: 0,
        updatedAt: Date.now(),
      });
    } else if (event.event === 'on_tool_end' || event.event === 'on_tool_error') {
      tuiSetThinking(true);
    }
  }

  ingest(chunk: Record<string, unknown>): AgentInterruptRequest | null {
    if (Array.isArray(chunk.todos)) {
      tuiSetTodos(chunk.todos as Todo[]);
    }

    for (const message of (chunk.messages ?? []) as unknown[]) {
      const id = (message as { id?: string }).id ?? '';
      if (id && this.seenMessageIds.has(id)) continue;
      if (id) this.seenMessageIds.add(id);

      if (message instanceof AIMessage) {
        const text = textOf(message.content).trim();
        if (text) this.lastAnswer = text;
        const toolCalls = message.tool_calls ?? [];
        for (const toolCall of toolCalls) {
          if (toolCall.name === 'write_todos') {
            tuiLog('📝 模型更新了任务清单');
          } else {
            tuiLog(
              `🔧 请求调用 ${A.bold}${toolCall.name}${A.reset}(${summarizeArgs(
                toolCall.name,
                (toolCall.args ?? {}) as Record<string, unknown>,
              )})`,
            );
          }
        }
      } else if (
        message instanceof ToolMessage &&
        message.name &&
        message.name !== 'write_todos'
      ) {
        const content = textOf(message.content).replace(/\s+/g, ' ').trim();
        const short = content.length > 70 ? `${content.slice(0, 70)}…` : content;
        tuiLog(
          `${A.green}✔${A.reset} ${A.bold}${message.name}${A.reset} ${A.dim}${short}${A.reset}`,
        );
        tuiSetThinking(true);
      }
    }

    const interrupts = (chunk as {
      __interrupt__?: Array<Interrupt<AgentInterruptRequest>>;
    }).__interrupt__;
    return interrupts?.[0]?.value ?? null;
  }

  showRecap(messages: unknown[]): void {
    for (const message of messages) {
      const id = (message as { id?: string }).id;
      if (id) this.seenMessageIds.add(id);
    }

    let lastHuman = '';
    let lastAi = '';
    for (const message of messages) {
      if (message instanceof HumanMessage) {
        const text = textOf(message.content).trim();
        if (text) lastHuman = text;
      } else if (message instanceof AIMessage) {
        const text = textOf(message.content).trim();
        if (text) lastAi = text;
      }
    }

    if (!lastHuman && !lastAi) return;
    tuiShowRecap({
      human: lastHuman.slice(0, 80),
      ai: lastAi.length > 200 ? `${lastAi.slice(0, 200)}…` : lastAi,
    });
  }

  private resetModelActivity(): void {
    this.activeModelMessageId = '';
    this.modelOutputChars = 0;
    this.modelToolName = '';
    this.lastActivityRenderAt = 0;
  }
}
