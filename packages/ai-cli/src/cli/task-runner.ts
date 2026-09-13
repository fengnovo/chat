import type { AgentEvent } from '@repo/contracts';

import { titleOf, type SessionStore } from '../sessions.js';
import {
  A,
  askApproval,
  askUserQuestion,
  tuiEnterTask,
  tuiFinish,
  tuiLog,
  tuiResetTask,
  tuiSetActivity,
  tuiSetThinking,
  tuiSetTodos,
  type ApprovalDecision,
} from '../tui/index.js';
import type { AgentRuntime } from './agent.js';

function outputSummary(output: unknown): string {
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length > 90 ? `${compact.slice(0, 90)}…` : compact;
}

export class TaskRunner {
  private autoApproveAll = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly sessionStore: SessionStore,
    private readonly threadId: string,
  ) {}

  async run(userInput: string): Promise<void> {
    tuiResetTask();
    tuiEnterTask();
    tuiLog(`${A.dim}用户：${userInput.split('\n')[0]?.slice(0, 60) ?? ''}${A.reset}`);
    tuiSetThinking(true);
    let answer = '';
    let stream = this.runtime.run(userInput);

    for (;;) {
      let interrupt: AgentEvent | null = null;
      let terminal = false;
      for await (const event of stream) {
        if (event.type === 'assistant.delta') {
          answer += event.text;
          tuiSetActivity({
            label: '正在生成模型回复',
            receivedChars: answer.length,
            updatedAt: Date.now(),
          });
        } else if (event.type === 'assistant.narration') {
          // 工具轮次里的过程旁白：只记日志，不计入最终答复。
          tuiLog(`${A.dim}${event.text}${A.reset}`);
        } else if (event.type === 'todo.updated') {
          tuiSetTodos(event.todos);
        } else if (event.type === 'tool.started') {
          tuiLog(`🔧 请求调用 ${A.bold}${event.tool}${A.reset}`);
          tuiSetActivity({
            label: `正在执行 ${event.tool}`,
            receivedChars: 0,
            updatedAt: Date.now(),
          });
        } else if (event.type === 'tool.completed') {
          tuiLog(
            `${A.green}✔${A.reset} ${A.bold}${event.tool}${A.reset} ${A.dim}${outputSummary(event.output)}${A.reset}`,
          );
        } else if (event.type === 'model.retry') {
          tuiLog(`${A.yellow}模型重试 ${event.attempt}：${event.reason}${A.reset}`);
        } else if (event.type === 'model.fallback') {
          tuiLog(`${A.yellow}模型降级 ${event.from} → ${event.to}${A.reset}`);
        } else if (
          event.type === 'approval.required' ||
          event.type === 'question.required'
        ) {
          interrupt = event;
        } else if (event.type === 'run.failed') {
          throw new Error(event.message);
        } else if (event.type === 'run.cancelled') {
          throw new Error('任务已取消');
        } else if (event.type === 'run.completed') {
          terminal = true;
        }
      }

      if (terminal) break;
      if (!interrupt) break;
      if (interrupt.type === 'question.required') {
        const response = await askUserQuestion({
          kind: 'ask_user',
          ...interrupt.question,
        });
        stream = this.runtime.resume({
          kind: 'question',
          answer: {
            selections: response.selections,
            ...(response.customText ? { customText: response.customText } : {}),
          },
        });
        tuiSetThinking(true);
        continue;
      }

      let decision: ApprovalDecision = this.autoApproveAll
        ? 'approve'
        : await askApproval(
            interrupt.actions.map((action) => ({
              name: action.name,
              summary: action.summary,
            })),
          );
      if (decision === 'approve-all') {
        this.autoApproveAll = true;
        decision = 'approve';
      }
      stream = this.runtime.resume({
        kind: 'approval',
        decision: decision === 'approve' ? 'approve' : 'reject',
      });
      tuiSetThinking(true);
    }

    tuiFinish(answer || '（无回复）');
    this.sessionStore.recordTask(this.threadId, titleOf(userInput));
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }
}
