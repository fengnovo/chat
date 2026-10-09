import { isBaseMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';

import { DurableExecutionError } from '../tool-execution.js';

export type GraphExecutionConfig = RunnableConfig & {
  durability?: 'sync' | 'async' | 'exit';
  streamMode?: Array<'values' | 'messages' | 'tools' | 'custom'>;
};

export interface GraphInterruptValue { id?: string; value?: unknown }
export interface GraphSnapshot {
  config?: RunnableConfig;
  metadata?: Record<string, unknown>;
  tasks?: Array<{ interrupts?: GraphInterruptValue[] }>;
  values?: { messages?: BaseMessage[]; [key: string]: unknown };
}

export type AgentStreamEvent =
  | ['values', Record<string, unknown>]
  | ['messages', [unknown, Record<string, unknown>]]
  | ['tools', Record<string, unknown>]
  | ['custom', unknown];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 集中校验框架值，避免在各处散落未检查的快照类型转换。 */
export function readGraphSnapshot(value: unknown): GraphSnapshot {
  if (!isRecord(value) ||
    (value.config !== undefined && !isRecord(value.config)) ||
    (value.metadata != null && !isRecord(value.metadata)) ||
    (value.tasks !== undefined && (!Array.isArray(value.tasks) || value.tasks.some((task) =>
      !isRecord(task) || (task.interrupts !== undefined && (!Array.isArray(task.interrupts) || task.interrupts.some((item) =>
        !isRecord(item) || (item.id !== undefined && typeof item.id !== 'string'))))))) ||
    (value.values !== undefined && (!isRecord(value.values) || (value.values.messages !== undefined &&
      (!Array.isArray(value.values.messages) || !value.values.messages.every(isBaseMessage)))))) {
    throw new DurableExecutionError('Invalid LangGraph recovery snapshot');
  }
  // 上述属性均已校验；metadata 为 null 表示上游传入了空快照。
  const snapshot = { ...value };
  if (snapshot.metadata === null) delete snapshot.metadata;
  return snapshot as GraphSnapshot;
}

export function firstGraphInterrupt(value: unknown): GraphInterruptValue | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.__interrupt__) && isRecord(value.__interrupt__[0])) return value.__interrupt__[0];
  return readGraphSnapshot(value).tasks?.flatMap((task) => task.interrupts ?? [])[0];
}

function graphMethod(graph: unknown, name: 'getState' | 'invoke' | 'stream'): (...args: unknown[]) => unknown {
  if (!isRecord(graph) || typeof graph[name] !== 'function') throw new DurableExecutionError(`LangGraph runtime is missing ${name}`);
  // 动态泛型图统一从这个经过校验且已绑定的边界进入。
  return (graph[name] as (...args: unknown[]) => unknown).bind(graph);
}

function streamEvent(value: unknown): AgentStreamEvent {
  if (Array.isArray(value) && value.length === 2) {
    const [mode, payload] = value;
    if (mode === 'custom') return ['custom', payload];
    if ((mode === 'values' || mode === 'tools') && isRecord(payload)) return [mode, payload];
    if (mode === 'messages' && Array.isArray(payload) && payload.length === 2 && isRecord(payload[1])) return ['messages', [payload[0], payload[1]]];
  }
  throw new DurableExecutionError('Invalid LangGraph stream frame');
}

export function adaptLangGraph(graph: unknown) {
  return {
    async getState(config: GraphExecutionConfig): Promise<GraphSnapshot> {
      return readGraphSnapshot(await graphMethod(graph, 'getState')(config));
    },
    async invoke(input: unknown, config: GraphExecutionConfig): Promise<unknown> {
      return graphMethod(graph, 'invoke')(input, config);
    },
    async stream(input: unknown, config: GraphExecutionConfig): Promise<AsyncIterable<AgentStreamEvent>> {
      const stream = await graphMethod(graph, 'stream')(input, config);
      if (!stream || typeof stream !== 'object' || !(Symbol.asyncIterator in stream) ||
        typeof stream[Symbol.asyncIterator] !== 'function') throw new DurableExecutionError('Invalid LangGraph stream');
      const iterable = stream as AsyncIterable<unknown>;
      return (async function* () { for await (const frame of iterable) yield streamEvent(frame); })();
    },
  };
}
