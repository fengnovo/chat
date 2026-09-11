import './langsmith.js';

import { initChatModel } from 'langchain/chat_models/universal';

function requiredEnv(
  name: 'MODEL' | 'OPENAI_API_KEY' | 'OPENAI_BASE_URL',
): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请先在项目根目录的 .env 中配置。`);
  }

  return value;
}

/**
 * demo20 专用模型：
 *
 * 与 demo13 相同的配置考量——DeepAgent 的 write_file 会把整份文件内容放进
 * 工具参数，maxTokens 过小会导致工具调用生成到一半被截断；同时关闭思考模式
 * 以避免长任务下多次模型调用叠加超时。
 */
export const model = await initChatModel(requiredEnv('MODEL'), {
  modelProvider: 'openai',
  apiKey: requiredEnv('OPENAI_API_KEY'),
  configuration: {
    baseURL: requiredEnv('OPENAI_BASE_URL'),
  },
  temperature: 1,
  maxTokens: 4_000,
  timeout: 300_000,
  maxRetries: 2,
  // qwen3.8：关闭思考模式，显著提速（思考模式下长任务易超时）
  modelKwargs: { enable_thinking: false },
  configurableFields: ['temperature', 'maxTokens'],
});
