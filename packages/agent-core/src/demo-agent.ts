import type { AgentEvent } from '@repo/contracts';

import type { AgentDriver, HeadlessAgentOptions, HeadlessAgentRuntime } from './types.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoAgentDriver implements AgentDriver {
  async create(options: HeadlessAgentOptions): Promise<HeadlessAgentRuntime> {
    async function* respond(message: string): AsyncIterable<AgentEvent> {
      yield { runId: options.runId, timestamp: new Date().toISOString(), type: 'run.started' };
      const answer = [
        'Node Agent Worker 已收到任务。',
        `当前会话 ${options.sessionId.slice(0, 8)} 正在使用独立 workspace。`,
        `你提交的是：“${message}”`,
        '配置 MODEL 和 OPENAI_API_KEY，并设置 AGENT_DRIVER=deep 后，将由 DeepAgent 执行真实编码任务。',
      ].join('\n\n');
      for (const chunk of answer.match(/.{1,5}/gs) ?? []) {
        if (options.signal?.aborted) {
          yield { runId: options.runId, timestamp: new Date().toISOString(), type: 'run.cancelled' };
          return;
        }
        yield {
          runId: options.runId,
          timestamp: new Date().toISOString(),
          type: 'assistant.delta',
          text: chunk,
        };
        await pause(20);
      }
      yield { runId: options.runId, timestamp: new Date().toISOString(), type: 'run.completed' };
    }

    return {
      backendMode: 'local',
      mcpStatus: 'demo driver',
      run: respond,
      resume() {
        return respond('已恢复任务');
      },
      async dispose() {},
    };
  }
}
