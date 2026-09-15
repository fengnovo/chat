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
  now?: () => number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

// 缓存 Promise 本身实现 single-flight：并发请求共享同一次建连，不会重复握手。
const sharedClients = new Map<string, Promise<SharedMcpEntry>>();

function buildEntry(
  raw: string,
  clientFactory: (config: Record<string, unknown>) => SharedMcpClientLike,
  now: () => number,
): Promise<SharedMcpEntry> {
  const config = JSON.parse(raw) as Record<string, unknown>;
  const client = clientFactory(config);
  return client.getTools().then((tools) => ({ client, tools, createdAt: now() }));
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
    // 超龄懒重建：同步判断 + 替换，并发的其他请求会拿到新 promise，不会重复建连。
    const replacement = buildEntry(raw, factory, now);
    replacement.catch(() => {
      if (sharedClients.get(key) === replacement) sharedClients.delete(key);
    });
    if (sharedClients.get(key) === existing) {
      sharedClients.set(key, replacement);
      void entry.client.close().catch(() => undefined);
      return replacement.then((built) => ({
        tools: built.tools,
        status: `${built.tools.length} tools connected (shared, rebuilt)`,
      }));
    }
    return sharedClients.get(key)!.then((built) => ({
      tools: built.tools,
      status: `${built.tools.length} tools connected (shared)`,
    }));
  }

  const promise = buildEntry(raw, factory, now);
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
