import type { StructuredToolInterface } from '@langchain/core/tools';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { createRequire } from 'node:module';

import { buildProductPrompt } from './capabilities/product-prompt.js';
import { reservedMcpToolNames } from './capabilities/mcp-tools.js';
import { subagentRuntimeDescriptor } from './subagent.js';
import { stableToolInputHash, trustedBuiltinReplayPolicies } from './tool-execution.js';
import type { HeadlessAgentOptions } from './types.js';

/** Bump when graph state/recovery compatibility changes beyond the hashed policies. */
export const AGENT_RUNTIME_VERSION = 'durable-agent-v2';
export const AGENT_GRAPH_VERSION = 'parent-attached-children-v2';

const require = createRequire(import.meta.url);
// Normal module loading resolves installed versions once. Descriptor builders
// remain pure and detect SDK upgrades even if a manual graph version is unchanged.
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
  // Hash all product branches so session approval and changing retrieved memory
  // do not masquerade as an incompatible deployment of the prompt template.
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

/** Host preflight uses this before sandbox acquisition or MCP discovery; no IO. */
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

/** Only stable non-secret execution identity is persisted; credentials never leave options. */
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
    // Source order can affect instruction precedence, so preserve it.
    skills: [...(options.skills ?? [])],
    memorySources: [...(options.memory ?? [])],
    longTermMemoryEnabled: options.longTermMemory !== undefined,
    modelCallLimit: options.modelCallLimit ?? 120,
    recursionLimit: options.recursionLimit ?? 600,
    summarization: options.summarization ?? { triggerTokens: 50_000, keepTokens: 15_000 },
  };
}
