import {
  flushLangSmithTraces,
  langSmithClient,
  langSmithTracing,
} from '../langsmith.js';

import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { HITLResponse } from 'langchain';
import { getCurrentRunTree, traceable } from 'langsmith/traceable';

import { titleOf, type SessionStore } from '../sessions.js';
import {
  A,
  askApproval,
  askUserQuestion,
  tuiLog,
  tuiSetThinking,
  tuiSetTodos,
  type ApprovalDecision,
} from '../tui/index.js';
import type { AgentRuntime } from './agent.js';
import {
  isUserQuestionRequest,
  StreamPresenter,
  summarizeArgs,
  type AgentInterruptRequest,
} from './stream-presenter.js';

interface TaskTraceConfig {
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface ToolStreamEvent {
  event?: string;
  name?: string;
}

type AgentStreamEvent =
  | ['values', Record<string, unknown>]
  | ['messages', [unknown, Record<string, unknown>]]
  | ['tools', ToolStreamEvent];

/** 执行一轮任务，处理 interrupt/resume、追踪和会话落盘。 */
export class TaskRunner {
  private autoApproveAll = false;
  private readonly presenter = new StreamPresenter();
  private readonly tracedRunTask: (
    userInput: string,
    traceConfig?: TaskTraceConfig,
  ) => Promise<void>;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly sessionStore: SessionStore,
  ) {
    this.tracedRunTask = traceable(
      async (userInput: string, _traceConfig?: TaskTraceConfig) => {
        await this.runTaskCore(userInput);
      },
      {
        name: 'demo20-cli-task',
        run_type: 'chain',
        argsConfigPath: [1],
        tags: ['demo20', 'coding-agent', runtime.backendMode],
        metadata: {
          application: 'demo20-cli-todo-approval',
          backend: runtime.backendMode,
          cwd: runtime.config.metadata.cwd,
        },
        ...(langSmithClient ? { client: langSmithClient } : {}),
      },
    );
  }

  get threadId(): string {
    return this.runtime.config.configurable.thread_id;
  }

  setThread(threadId: string): void {
    this.runtime.config.configurable.thread_id = threadId;
    this.runtime.config.metadata.thread_id = threadId;
  }

  async run(userInput: string): Promise<void> {
    try {
      await this.tracedRunTask(userInput, {
        tags: ['cli-turn'],
        metadata: { thread_id: this.threadId },
      });
    } finally {
      await flushLangSmithTraces();
    }
  }

  /** 恢复会话时显示最后一轮回顾，并预加载消息 ID 防止历史流重复渲染。 */
  async printRecap(): Promise<void> {
    try {
      const snapshot = (await this.runtime.agent.getState(this.runtime.config)) as {
        values?: { messages?: unknown[] };
      };
      this.presenter.showRecap(snapshot.values?.messages ?? []);
    } catch {
      // 回顾失败不阻塞进入会话
    }
  }

  private async runTaskCore(userInput: string): Promise<void> {
    this.presenter.beginTask(userInput);
    const currentTrace = getCurrentRunTree(true);
    if (langSmithTracing.enabled && currentTrace) {
      this.presenter.showTrace(currentTrace.trace_id);
    }

    let input: unknown = { messages: [new HumanMessage(userInput)], todos: [] };

    for (;;) {
      let interruptRequest: AgentInterruptRequest | null = null;
      const stream = (await this.runtime.agent.stream(
        input as never,
        this.runtime.config,
      )) as unknown as AsyncIterable<AgentStreamEvent>;
      for await (const [mode, payload] of stream) {
        if (mode === 'messages') {
          this.presenter.ingestModelChunk(payload[0]);
        } else if (mode === 'tools') {
          this.presenter.ingestToolEvent(payload);
        } else {
          const request = this.presenter.ingest(payload);
          if (request) interruptRequest = request;
        }
      }

      if (!interruptRequest) {
        const state = (await this.runtime.agent.getState(this.runtime.config)) as {
          tasks?: Array<{ interrupts?: Array<{ value: unknown }> }>;
        };
        const paused = state.tasks?.find((task) => (task.interrupts?.length ?? 0) > 0);
        if (paused?.interrupts?.[0]) {
          interruptRequest = paused.interrupts[0].value as AgentInterruptRequest;
        }
      }

      if (!interruptRequest) break;

      if (isUserQuestionRequest(interruptRequest)) {
        const answer = await askUserQuestion(interruptRequest);
        const labels = answer.selections.map((selection) => selection.label);
        if (answer.customText) labels.push(answer.customText);
        tuiLog(`${A.cyan}💬 用户选择${A.reset} ${labels.join('、')}`);
        input = new Command({ resume: answer });
        tuiSetThinking(true);
        continue;
      }

      let decision: ApprovalDecision;
      if (this.autoApproveAll) {
        decision = 'approve';
        tuiLog(`${A.dim}（会话全部批准模式）自动放行${A.reset}`);
      } else {
        decision = await askApproval(
          interruptRequest.actionRequests.map((request) => ({
            name: request.name,
            summary: summarizeArgs(request.name, request.args ?? {}),
          })),
        );
      }

      if (decision === 'approve-all') {
        this.autoApproveAll = true;
        decision = 'approve';
        tuiLog(`${A.yellow}⚡ 已开启「本次会话全部批准」，后续工具调用不再逐个询问${A.reset}`);
      } else {
        tuiLog(
          decision === 'approve'
            ? `${A.green}✅ 已批准${A.reset} ${interruptRequest.actionRequests.map((request) => request.name).join('、')}`
            : `${A.red}⛔ 已拒绝${A.reset} ${interruptRequest.actionRequests.map((request) => request.name).join('、')}`,
        );
      }

      const rejected = decision === 'reject';
      const resume: HITLResponse = {
        decisions: interruptRequest.actionRequests.map(() =>
          decision === 'approve'
            ? { type: 'approve' }
            : {
                type: 'reject',
                message:
                  '用户在 CLI 审批中拒绝了该操作。请放弃此步骤，或换一种不需要该操作的方式完成任务。',
              },
        ),
      };
      input = new Command({
        resume,
        ...(rejected ? { update: { todos: [] } } : {}),
      });
      if (rejected) tuiSetTodos([]);
      tuiSetThinking(true);
    }

    this.presenter.finish();
    this.sessionStore.recordTask(this.threadId, titleOf(userInput));
  }
}
