#!/usr/bin/env node

import './langsmith.js';

// LangSmith 初始化必须先于 app 及其 LangChain/LangGraph 依赖执行，确保模型和
// 回调管理器创建时已经读取 .env 并设置好追踪开关。

import { runCli } from './cli/app.js';
import { A, stopTui } from './tui/index.js';

/**
 * Coding Agent CLI
 *
 * pnpm start
 * pnpm start "帮我写一个冒泡排序并测试"
 * pnpm start --cwd /path/to/project
 */

process.on('SIGINT', () => {
  stopTui();
  process.exit(0);
});

runCli().catch((error: unknown) => {
  stopTui();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${A.red}启动失败：${message}${A.reset}`);
  process.exitCode = 1;
});
