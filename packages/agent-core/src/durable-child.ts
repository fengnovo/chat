import { HumanMessage } from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Command, interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { adaptLangGraph, firstGraphInterrupt, type GraphSnapshot } from './adapters/langgraph.js';

import { DurableExecutionError, isDurableExecutionError, stableToolInputHash } from './tool-execution.js';
import type { DurableChildRecord, SpawnSubagentInput, SpawnSubagentOptions } from './subagent.js';

export function isDurableChildError(error: unknown): boolean {
  return isDurableExecutionError(error) || (typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === 'DURABLE_EXECUTION_INTERRUPTED');
}

export function durableChildFailure(error: unknown): unknown {
  if (isDurableChildError(error) || isGraphInterrupt(error)) return error;
  return Object.assign(new DurableExecutionError('Durable child execution interrupted', { cause: error }), {
    code: 'DURABLE_EXECUTION_INTERRUPTED',
  });
}

export async function childStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw durableChildFailure(error); }
}

interface ChildInterruptState {
  kind: 'interrupt';
  request: unknown;
  interruptId: string;
  checkpointId: string;
  response?: unknown;
  history?: Array<{ request: unknown; response: unknown }>;
}

function interruptState(value: unknown): ChildInterruptState | null {
  if (typeof value !== 'object' || value === null || (value as { kind?: unknown }).kind !== 'interrupt') return null;
  return value as ChildInterruptState;
}

/** 分离的图无法调用父级的 interrupt() 暂存区，因此由根图传递此请求。 */
export class DurableChildInterruptError extends DurableExecutionError {
  readonly code = 'DURABLE_EXECUTION_INTERRUPTED';
  readonly interruptId: string;
  constructor(readonly record: DurableChildRecord, readonly request: unknown) {
    super('Background child is waiting for user approval');
    this.name = 'DurableChildInterruptError';
    this.interruptId = interruptState(record.review)?.interruptId ?? `child-${record.id}-${record.attempt}`;
  }
}

/** 在根图开始下一轮执行前，先持久化后台审批。 */
export async function resumeBackgroundChild(
  options: SpawnSubagentOptions,
  response: unknown,
  interruptId?: string,
): Promise<boolean> {
  if (!options.durable) return false;
  const records = await childStoreOperation(() => options.durable!.store.listBackground());
  const waiting = records.filter((record) => record.status === 'waiting' && interruptState(record.review));
  // 只有恰好一个子任务在等待时，未指明对象的响应才安全。
  const record = interruptId
    ? waiting.find((item) => interruptState(item.review)?.interruptId === interruptId)
    : waiting.length === 1 ? waiting[0] : undefined;
  if (!record) return false;
  const state = interruptState(record.review)!;
  await childStoreOperation(() => options.durable!.store.save(record.id, {
    review: { ...state, response },
  }));
  return true;
}

/** 在父图继承的配置之外，调用拥有独立检查点的尝试。 */
export async function invokeDurableChildGraph(
  graphValue: unknown,
  input: SpawnSubagentInput,
  options: SpawnSubagentOptions,
  invocationConfig: unknown = {},
): Promise<unknown> {
  const execution = options.childExecution;
  if (!execution || !options.durable) throw new Error('Durable child attempt context is required');
  if (execution.record.status === 'cancelled') throw new DurableExecutionError('Cancelled child cannot resume its graph');
  const graph = adaptLangGraph(graphValue);
  let record = execution.record;
  const threadId = `${record.threadId}:attempt:${record.attempt}`;
  const config = {
    ...(invocationConfig as object),
    configurable: { thread_id: threadId, checkpoint_ns: '' },
    metadata: {
      business_run_id: options.runId,
      run_id: `${record.id}:attempt:${record.attempt}`,
      child_id: record.id,
      child_attempt: record.attempt,
    },
    durability: 'sync' as const,
  };
  // 即使传入了显式 configurable，LangGraph 仍会合并当前 runnable 配置。
  // 替换当前上下文还能避免嵌套图继承读取器、检查点保存器和命名空间。
  const isolated = <T>(operation: () => Promise<T>) =>
    AsyncLocalStorageProviderSingleton.runWithConfig(config, operation);
  const save = async (patch: Partial<DurableChildRecord>) => {
    record = await childStoreOperation(() => options.durable!.store.save(record.id, patch));
  };
  const history = [...(interruptState(record.review)?.history ?? [])];
  const approval = async (request: unknown, checkpointId: unknown): Promise<Command> => {
    if (typeof checkpointId !== 'string' || !checkpointId) {
      throw new Error('Interrupted child checkpoint has no stable identity');
    }
    const candidate = interruptState(record.review);
    // 可能在下一个 interrupt 已写入检查点、请求尚未保存时发生崩溃。
    // 绝不能将某个审批复用于其他已提交的检查点。
    const saved = candidate?.checkpointId === checkpointId &&
      stableToolInputHash(candidate.request) === stableToolInputHash(request) ? candidate : null;
    const marker = (request as { durableApprovalId?: unknown } | null)?.durableApprovalId;
    const interruptId = `child-${record.id}-${record.attempt}${typeof marker === 'string' ? `-${marker}` : ''}`;
    if (!saved) await save({ status: 'waiting', review: { kind: 'interrupt', request, interruptId, checkpointId, history } });
    const state = interruptState(record.review)!;
    let response: unknown;
    if (Object.prototype.hasOwnProperty.call(state, 'response')) {
      response = state.response;
    } else if (execution.background) {
      throw new DurableChildInterruptError(record, state.request);
    } else {
      // 此调用有意使用恢复后的父图上下文，不放在 isolated() 中执行。
      response = interrupt(state.request);
      if (typeof marker === 'string') {
        // 父任务失败后，除按位置保存的历史外，还可能留有旧的未限定响应。
        // 只有明确对应当前重试的响应才是最新的。
        while ((history.length > 0 || (response as { durableApprovalId?: unknown } | null)?.durableApprovalId !== undefined) &&
          (response as { durableApprovalId?: unknown } | null)?.durableApprovalId !== marker) {
          response = interrupt(state.request);
        }
      }
      history.push({ request: state.request, response });
      await save({ review: { ...state, response, history } });
    }
    // 即使原生 interrupt ID 复用了任务 ID，工具保护逻辑仍能识别后续重试。
    const childResponse = typeof marker === 'string' && typeof response === 'object' && response !== null
      ? { ...response, durableApprovalId: marker } : response;
    return new Command({ resume: childResponse });
  };
  try {
    if (!execution.background) {
      // 父级 interrupt 响应按位置对应。将新的子任务请求转交给同一父任务前，
      // 先跳过本次 spawn 已用过的响应位置。
      for (const previous of history) interrupt(previous.request);
    }
    let snapshot: GraphSnapshot = await isolated(() => graph.getState(config));
    const checkpointExists = snapshot.config?.configurable?.checkpoint_id !== undefined;
    if (checkpointExists && (snapshot.metadata?.child_id !== record.id ||
      snapshot.metadata?.child_attempt !== record.attempt || snapshot.metadata?.business_run_id !== options.runId)) {
      throw new Error('Child checkpoint belongs to a different invocation');
    }
    let graphInput: unknown = checkpointExists ? null : { messages: [new HumanMessage(input.task)] };
    const paused = firstGraphInterrupt(snapshot);
    if (paused) graphInput = await approval(paused.value, snapshot.config?.configurable?.checkpoint_id);
    while (true) {
      const result = await isolated(() => graph.invoke(graphInput, config));
      snapshot = await isolated(() => graph.getState(config));
      const paused = firstGraphInterrupt(result) ?? firstGraphInterrupt(snapshot);
      if (!paused) return result;
      graphInput = await approval(paused.value, snapshot.config?.configurable?.checkpoint_id);
    }
  } catch (error) {
    throw durableChildFailure(error);
  }
}
