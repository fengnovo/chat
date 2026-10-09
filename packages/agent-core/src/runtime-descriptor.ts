import type { StructuredToolInterface } from '@langchain/core/tools';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { createRequire } from 'node:module';

import { buildProductPrompt } from './capabilities/product-prompt.js';
import { reservedMcpToolNames } from './capabilities/mcp-tools.js';
import { subagentRuntimeDescriptor } from './subagent.js';
import { stableToolInputHash, trustedBuiltinReplayPolicies } from './tool-execution.js';
import type { HeadlessAgentOptions } from './types.js';

/** 图状态或恢复兼容性发生哈希策略无法体现的变化时，递增此版本。 */
export const AGENT_RUNTIME_VERSION = 'durable-agent-v2';
export const AGENT_GRAPH_VERSION = 'parent-attached-children-v2';

const require = createRequire(import.meta.url);
// 普通模块加载只解析一次已安装的版本。描述符构造器保持纯函数；即使手动图版本未变，
// 也能检测 SDK 升级。
const frameworkVersions = Object.fromEntries([
  'deepagents', 'langchain', '@langchain/core', '@langchain/langgraph',
  '@langchain/mcp-adapters', '@langchain/openai', '@langchain/anthropic',
].map((name) => {
  const metadata: unknown = require(`${name}/package.json`);
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') {
    throw new Error(`Missing installed framework version for ${name}`);
  }
  return [name, metadata.version];
}));

function modelEndpoint(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function promptTemplateHash(): string {
  // 对所有产品提示分支计算哈希，避免会话审批或召回记忆变化被误判为
  // 提示模板部署不兼容。
  const templates: string[] = [];
  for (const backendMode of ['docker', 'e2b'] as const) {
    for (const knowledgeEnabled of [false, true]) {
      for (const autoApproveTools of [false, true]) {
        for (const memory of [false, true]) {
          templates.push(buildProductPrompt({ workspacePath: '<workspace>', backendMode,
            knowledgeEnabled, autoApproveTools,
            ...(memory ? { longTermMemory: { store: null, namespace: [], context: '<retrieved-memory>' } } : {}),
          }));
        }
      }
    }
  }
  return stableToolInputHash(templates);
}

/** 宿主预检会在获取沙箱或发现 MCP 工具前调用此函数；不执行 IO。 */
export function buildRuntimeStaticDescriptor(): Record<string, unknown> {
  return {
    runtimeVersion: AGENT_RUNTIME_VERSION,
    graphVersion: AGENT_GRAPH_VERSION,
    promptTemplateHash: promptTemplateHash(),
    subagent: subagentRuntimeDescriptor(),
    builtinReplayPolicies: trustedBuiltinReplayPolicies(),
    reservedMcpToolNames: reservedMcpToolNames(),
    frameworkVersions: { ...frameworkVersions },
  };
}

/** 只持久化稳定且不含机密的执行身份；凭据不会离开 options。 */
export function buildRuntimeDescriptor(
  options: HeadlessAgentOptions,
  tools: readonly StructuredToolInterface[],
): Record<string, unknown> {
  const toolDescriptors = tools.map((item) => ({
    name: item.name,
    schemaHash: stableToolInputHash(toJsonSchema(item.schema)),
    descriptionHash: stableToolInputHash(item.description),
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    ...buildRuntimeStaticDescriptor(),
    backendMode: options.backendMode ?? 'e2b',
    models: options.models.map((model) => ({ id: model.id, provider: model.provider,
      model: model.model, baseUrl: modelEndpoint(model.baseUrl), maxTokens: model.maxTokens ?? 16_000,
    })),
    tools: toolDescriptors,
    toolPolicies: options.durable?.toolPolicies ?? {},
    resources: options.durable?.runtimeResources ?? {},
    // 源顺序会影响指令优先级，因此必须保留。
    skills: [...(options.skills ?? [])],
    memorySources: [...(options.memory ?? [])],
    longTermMemoryEnabled: options.longTermMemory !== undefined,
    modelCallLimit: options.modelCallLimit ?? 120,
    recursionLimit: options.recursionLimit ?? 600,
    summarization: options.summarization ?? { triggerTokens: 50_000, keepTokens: 15_000 },
  };
}
