import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { MultiServerMCPClient } from '@langchain/mcp-adapters';

/**
 * base MCP（配置文件驱动、无 per-run 凭证）的 client 进程级缓存。
 * 连接生命周期与单次请求解耦：首次连接后常驻复用，配置内容变更或超 TTL 才重建，
 * 消除"每条消息都重新握手公网 MCP"的秒级开销。knowledgeMcp 携带 per-run JWT
 * （绑定 run、5 分钟过期），不能跨 run 复用，不走此缓存。
 */

type McpTools = Awaited<ReturnType<MultiServerMCPClient['getTools']>>;

export interface SharedMcpClientLike {
  getTools(): Promise<McpTools>;
  close(): Promise<void>;
}

interface SharedMcpEntry {
  client: SharedMcpClientLike;
  tools: McpTools;
  createdAt: number;
}

export interface SharedMcpTools {
  tools: McpTools;
  status: string;
}

export interface SharedMcpCacheOptions {
  /** 测试注入点：默认 new MultiServerMCPClient(config)。 */
  clientFactory?: (config: Record<string, unknown>) => SharedMcpClientLike;
  /** 缓存条目存活时长，超龄后下次使用时懒重建（兜底 server 重启等静默死连接）。 */
  ttlMs?: number;
  /**
   * 建连 + 工具发现的最长等待。@langchain/mcp-adapters 1.x 不透传配置里的 timeout，
   * SDK 对"TCP 可连但不响应"的黑洞端点默认要等 60s；这里用 Promise.race 自己兜底，
   * 超时按连接失败处理（不缓存、可重试）。
   */
  connectTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/**
 * 展开 MCP 配置里的 `${ENV_VAR}` 占位（如 API key 放 .env 而不是提交进 git）。
 * headers 下引用了未设置/空白变量的条目整条剔除（如 `Bearer ${KEY}` 缺 key 时
 * 退化成 `Bearer `，trim 后仍有 "Bearer" 字样，不能按空串判断；发出去只会换来 401）。
 */
export function expandEnvPlaceholders(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  key = '',
): unknown {
  const hasUnresolvedPlaceholder = (text: string): boolean =>
    Array.from(text.matchAll(ENV_PLACEHOLDER)).some(
      (match) => !env[match[1] ?? '']?.trim(),
    );
  const expand = (input: unknown, parentKey = ''): unknown => {
    if (typeof input === 'string') {
      return input.replace(ENV_PLACEHOLDER, (_match, name: string) => env[name] ?? '');
    }
    if (Array.isArray(input)) {
      return input.map((item) => expand(item, parentKey));
    }
    if (input && typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>).flatMap(
        ([entryKey, entryValue]) => {
          if (
            parentKey === 'headers' &&
            typeof entryValue === 'string' &&
            hasUnresolvedPlaceholder(entryValue)
          ) {
            return [];
          }
          return [[entryKey, expand(entryValue, entryKey)]];
        },
      );
      return Object.fromEntries(entries);
    }
    return input;
  };
  return expand(value, key);
}

// 缓存 Promise 本身实现 single-flight：并发请求共享同一次建连，不会重复握手。
const sharedClients = new Map<string, Promise<SharedMcpEntry>>();

function buildEntry(
  raw: string,
  clientFactory: (config: Record<string, unknown>) => SharedMcpClientLike,
  now: () => number,
  connectTimeoutMs: number,
): Promise<SharedMcpEntry> {
  const config = expandEnvPlaceholders(JSON.parse(raw)) as Record<string, unknown>;
  const client = clientFactory(config);
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP connect/tools discovery timed out after ${connectTimeoutMs}ms`)),
      connectTimeoutMs,
    );
    // 底层握手可能仍在 pending（适配器不可取消）；unref 避免悬挂定时器拖住进程退出。
    timer.unref?.();
  });
  return Promise.race([client.getTools(), deadline]).then(
    (tools) => ({ client, tools, createdAt: now() }),
    async (error: unknown) => {
      // 连接/发现失败（含超时）时关闭可能半开的 client，再向上抛——调用方不缓存失败条目。
      await client.close().catch(() => undefined);
      throw error;
    },
  );
}

/**
 * 按配置文件内容取共享 MCP 工具。文件内容指纹（sha256）做缓存 key：
 * 配置变更自动失效重建；构建失败不缓存，下次调用自动重试。
 */
export async function getSharedMcpToolsForConfigPath(
  configPath: string,
  options: SharedMcpCacheOptions = {},
): Promise<SharedMcpTools> {
  const raw = await readFile(configPath, 'utf8');
  const key = createHash('sha256').update(raw).digest('hex');
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const factory = options.clientFactory ?? ((config) => new MultiServerMCPClient(config as never));

  const existing = sharedClients.get(key);
  if (existing) {
    let entry: SharedMcpEntry;
    try {
      entry = await existing;
    } catch {
      // 失败条目已被清理；重试一次（最多递归一层，重建再失败会直接抛给调用方）。
      return getSharedMcpToolsForConfigPath(configPath, options);
    }
    const current = sharedClients.get(key);
    if (current !== existing) {
      // 已被并发请求重建，直接等新条目。
      return current!.then((built) => ({
        tools: built.tools,
        status: `${built.tools.length} tools connected (shared)`,
      }));
    }
    if (now() - entry.createdAt <= ttlMs) {
      return { tools: entry.tools, status: `${entry.tools.length} tools connected (shared)` };
    }
    // 超龄懒重建（stale-while-revalidate）：新连接握手成功前不动旧 client。
    // 重建失败时继续返回旧工具，并把旧条目时钟拨到当前、TTL 后再试，
    // 避免一次公网抖动/限流直接让整轮对话没有 MCP 工具。
    const replacement = buildEntry(raw, factory, now, connectTimeoutMs);
    if (sharedClients.get(key) === existing) {
      sharedClients.set(key, replacement);
      try {
        const built = await replacement;
        void entry.client.close().catch(() => undefined);
        return {
          tools: built.tools,
          status: `${built.tools.length} tools connected (shared, rebuilt)`,
        };
      } catch {
        const fallback: Promise<SharedMcpEntry> = Promise.resolve({ ...entry, createdAt: now() });
        if (sharedClients.get(key) === replacement) sharedClients.set(key, fallback);
        return {
          tools: entry.tools,
          status: `${entry.tools.length} tools connected (shared, stale)`,
        };
      }
    }
    return sharedClients.get(key)!.then((built) => ({
      tools: built.tools,
      status: `${built.tools.length} tools connected (shared)`,
    }));
  }

  const promise = buildEntry(raw, factory, now, connectTimeoutMs);
  promise.catch(() => {
    if (sharedClients.get(key) === promise) sharedClients.delete(key);
  });
  sharedClients.set(key, promise);
  const entry = await promise;
  return { tools: entry.tools, status: `${entry.tools.length} tools connected (shared)` };
}

/** 关闭并清空全部共享 client（worker 优雅关闭与测试 reset 使用）。 */
export async function closeSharedMcpClients(): Promise<void> {
  const entries = [...sharedClients.values()];
  sharedClients.clear();
  const settled = await Promise.allSettled(entries);
  await Promise.allSettled(
    settled
      .filter((result): result is PromiseFulfilledResult<SharedMcpEntry> => result.status === 'fulfilled')
      .map((result) => result.value.client.close()),
  );
}
