/**
 * demo20 的 LangSmith 初始化入口。
 *
 * 这个文件只负责“可观测性”，不负责创建 Agent 或调用大模型，具体做五件事：
 * 1. 在 LangChain / LangGraph 初始化前读取 `.env`；
 * 2. 根据 API Key 和开关判断是否启用追踪；
 * 3. 为没有显式设置项目名的情况提供默认项目名；
 * 4. 创建上传 Trace 所需的 LangSmith Client；
 * 5. CLI 退出或一轮任务结束时，等待尚未上传的日志发送完成。
 *
 * `cli.ts` 和 `model.ts` 必须先导入本模块，再导入 LangChain/LangGraph。
 * 否则这些库初始化回调系统时可能还看不到 LANGSMITH_* 环境变量。
 */
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'langsmith';

const demoEnvPath = fileURLToPath(new URL('../.env', import.meta.url));
const repositoryEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));

// 读取顺序即优先级：demo20 自己的配置优先，仓库根配置只补齐缺失项。
// dotenv 默认不会覆盖已经存在的 process.env，因此终端里显式 export 的变量
// 仍然拥有最高优先级。
const envCandidates = [
  { path: demoEnvPath, label: 'demo20/.env' },
  { path: repositoryEnvPath, label: '仓库根目录/.env' },
];
const loadedEnvFiles: string[] = [];
for (const candidate of envCandidates) {
  if (!existsSync(candidate.path)) continue;
  dotenv.config({ path: candidate.path, quiet: true });
  loadedEnvFiles.push(candidate.label);
}

const DEFAULT_PROJECT = 'demo20-cli-todo-approval';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isEnabled(value: string | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? '');
}

const apiKey = process.env.LANGSMITH_API_KEY?.trim();

// 只配置 API Key 时默认开启追踪；如果用户明确写了 false，则尊重关闭设置。
if (process.env.LANGSMITH_TRACING === undefined && apiKey) {
  process.env.LANGSMITH_TRACING = 'true';
}

// 每条 Trace 都会归入这个项目；用户可在 .env 中覆盖默认值。
if (!process.env.LANGSMITH_PROJECT?.trim()) {
  process.env.LANGSMITH_PROJECT = DEFAULT_PROJECT;
}

const tracingRequested = isEnabled(process.env.LANGSMITH_TRACING);

// 开了追踪却没有 Key 时主动关闭，避免后台上传的鉴权错误影响 CLI 使用。
if (tracingRequested && !apiKey) {
  process.env.LANGSMITH_TRACING = 'false';
} else if (tracingRequested) {
  // LangChain 回调管理器识别的是小写字符串 "true"，这里统一格式。
  process.env.LANGSMITH_TRACING = 'true';
}

const envSourceText =
  loadedEnvFiles.length > 0 ? `；已读取：${loadedEnvFiles.join('、')}` : '；未找到 .env';

// 提供给 TUI 启动横幅和 cli.ts 判断使用，不包含或输出 API Key。
export const langSmithTracing = {
  enabled: tracingRequested && Boolean(apiKey),
  project: process.env.LANGSMITH_PROJECT,
  endpoint: process.env.LANGSMITH_ENDPOINT?.trim() || 'https://api.smith.langchain.com',
  status: tracingRequested
    ? apiKey
      ? `已启用（项目：${process.env.LANGSMITH_PROJECT}${envSourceText}）`
      : `未启用（缺少 LANGSMITH_API_KEY${envSourceText}）`
    : `未启用（设置 LANGSMITH_TRACING=true${envSourceText}）`,
} as const;

// 显式创建 Client，既供 traceable 使用，也用于主动等待日志上传完成。
export const langSmithClient = langSmithTracing.enabled ? new Client() : undefined;

/** 等待待上传的 Trace 批次完成，防止单任务模式退出太快而丢日志。 */
export async function flushLangSmithTraces(): Promise<void> {
  if (!langSmithClient) return;
  try {
    await langSmithClient.awaitPendingTraceBatches();
  } catch {
    // 日志上传失败不能反过来导致 Coding Agent 的主任务失败。
  }
}
