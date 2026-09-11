import { existsSync } from 'node:fs';

import { langSmithTracing } from '../langsmith.js';
import { SessionStore, formatRelative } from '../sessions.js';
import {
  A,
  askReplInput,
  pickSession,
  startTui,
  stopTui,
  tuiEnterRepl,
  tuiLog,
  tuiSetHeader,
  tuiSetThinking,
  tuiShowBanner,
  tuiShowStartLine,
} from '../tui/index.js';
import { createAgentRuntime, type AgentRuntime } from './agent.js';
import { createCliSettings, type CliSettings } from './config.js';
import { errorMessage, isRecoverableNetworkError } from './errors.js';
import { TaskRunner } from './task-runner.js';

function showBanner(settings: CliSettings, runtime: AgentRuntime): void {
  tuiShowBanner({
    mode:
      runtime.backendMode === 'sandbox'
        ? '☁️ LangSmith 云沙箱'
        : '💻 本机（真实磁盘 + shell）',
    cwd: settings.cwd,
    skills:
      settings.skillCount > 0
        ? `${settings.skillCount} 个技能（${settings.skillsHostDir}）`
        : `未配置（放 SKILL.md 到 ${settings.skillsHostDir}/<技能名>/）`,
    mcp: runtime.mcpStatus,
    langsmith: langSmithTracing.status,
    memory: `${settings.memoryHostFile}${existsSync(settings.memoryHostFile) ? '' : '（尚不存在，agent 可自行创建）'}`,
  });
}

function showTaskError(error: unknown): void {
  tuiSetThinking(false);
  const message = errorMessage(error);
  tuiLog(
    isRecoverableNetworkError(error)
      ? `${A.red}网络请求失败：${message}${A.reset} ${A.dim}会话已保留，网络恢复后可重新提交任务。${A.reset}`
      : `${A.red}任务执行出错：${message}${A.reset}`,
  );
}

async function runRepl(taskRunner: TaskRunner): Promise<void> {
  for (;;) {
    tuiEnterRepl();
    const task = (await askReplInput()).trim();
    if (!task) continue;
    if (task === '/exit' || task === '/quit') return;
    try {
      await taskRunner.run(task);
    } catch (error) {
      showTaskError(error);
    }
  }
}

export async function runCli(): Promise<void> {
  const settings = createCliSettings();
  const sessionStore = new SessionStore(settings.projectDir);
  tuiSetHeader(`DeepAgents Coding Agent · 工作目录: ${settings.cwd}`);
  startTui();

  let threadId = `cli-${Date.now()}`;
  if (!settings.oneShotTask) {
    const sessions = sessionStore.list();
    const picked = await pickSession([
      { title: '🆕 开始新会话', subtitle: '' },
      ...sessions.map((session) => ({
        title: `💬 ${session.title}`,
        subtitle: `${session.tasks} 个任务 · ${formatRelative(session.updatedAt)}`,
      })),
    ]);
    const session = picked > 0 ? sessions[picked - 1] : undefined;
    if (session) {
      threadId = session.threadId;
      tuiShowStartLine(
        `▶ 恢复会话：${session.title}（${session.tasks} 个任务，最后活跃 ${formatRelative(session.updatedAt)}）`,
      );
    } else {
      tuiShowStartLine('▶ 开始新会话');
    }
  }

  const runtime = await createAgentRuntime(settings, sessionStore, threadId);
  const taskRunner = new TaskRunner(runtime, sessionStore, threadId);
  tuiSetHeader(
    `DeepAgents Coding Agent · 模式: ${runtime.backendMode === 'sandbox' ? '☁️ 云沙箱' : '💻 本机'} · 工作目录: ${settings.cwd}`,
  );
  showBanner(settings, runtime);

  try {
    if (settings.oneShotTask) {
      try {
        await taskRunner.run(settings.oneShotTask);
        return;
      } catch (error) {
        if (!process.stdin.isTTY || !isRecoverableNetworkError(error)) throw error;
        showTaskError(error);
        tuiShowStartLine('▶ 单任务因网络错误中断，已转入交互模式');
      }
    }
    await runRepl(taskRunner);
  } finally {
    await taskRunner.dispose();
    stopTui();
  }
}
