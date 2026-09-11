/**
 * Backend 工厂：决定 agent 的文件操作与命令执行落在哪里。
 *
 * - 本地模式（默认）：LocalShellBackend —— 文件真实落盘到 rootDir，
 *   shell 命令直接在宿主机执行（无沙箱隔离，所以危险操作前面有 HITL 审批）。
 * - 沙箱模式（CODE_AGENT_BACKEND=sandbox）：LangSmithSandbox —— 命令与文件
 *   都在 LangSmith 云端沙箱内执行，需要 LangSmith 账号 / API Key。
 */

import { LangSmithSandbox, LocalShellBackend } from 'deepagents';

export interface BackendHandle {
  backend: LocalShellBackend | LangSmithSandbox;
  mode: 'local' | 'sandbox';
}

export async function createBackend(rootDir: string): Promise<BackendHandle> {
  if (process.env.CODE_AGENT_BACKEND === 'sandbox') {
    try {
      const backend = await LangSmithSandbox.create({});
      return { backend, mode: 'sandbox' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `LangSmith 云沙箱创建失败：${message}\n` +
          '沙箱模式需要 LangSmith 账号与 API Key（设置 LANGSMITH_API_KEY）。\n' +
          '去掉环境变量 CODE_AGENT_BACKEND=sandbox 即可使用本地模式（真实磁盘 + 本机 shell）。',
      );
    }
  }

  const backend = new LocalShellBackend({
    rootDir,
    virtualMode: false, // false = 文件真实写入磁盘
    timeout: 180, // 单条命令超时（秒）
    maxOutputBytes: 200_000, // 命令输出截断阈值
    inheritEnv: true, // 继承本机 PATH 等环境变量，保证 node/pnpm/git 可用
  });
  await backend.initialize(); // 确保 rootDir 存在
  return { backend, mode: 'local' };
}
