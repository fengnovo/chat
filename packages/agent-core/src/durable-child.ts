import { HumanMessage } from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Command, interrupt, isGraphInterrupt } from '@langchain/langgraph';

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

/** Detached graphs cannot invoke the parent's interrupt() scratchpad. The root surfaces this request. */
export class DurableChildInterruptError extends DurableExecutionError {
  readonly code = 'DURABLE_EXECUTION_INTERRUPTED';
  readonly interruptId: string;
  constructor(readonly record: DurableChildRecord, readonly request: unknown) {
    super('Background child is waiting for user approval');
    this.name = 'DurableChildInterruptError';
    this.interruptId = interruptState(record.review)?.interruptId ?? `child-${record.id}-${record.attempt}`;
  }
}

/** Persist a background approval before the root starts another execution pass. */
export async function resumeBackgroundChild(
  options: SpawnSubagentOptions,
  response: unknown,
  interruptId?: string,
): Promise<boolean> {
  if (!options.durable) return false;
  const records = await childStoreOperation(() => options.durable!.store.listBackground());
  const waiting = records.filter((record) => record.status === 'waiting' && interruptState(record.review));
  // An unaddressed response is safe only when exactly one child is waiting.
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

interface ChildSnapshot {
  config?: { configurable?: { checkpoint_id?: unknown } };
  metadata?: { child_id?: unknown; child_attempt?: unknown; business_run_id?: unknown } | null;
  tasks?: Array<{ interrupts?: Array<{ value: unknown }> }>;
}

interface ChildGraph {
  getState(config: never): Promise<unknown>;
  invoke(input: never, config: never): Promise<unknown>;
}

function firstInterrupt(value: unknown): { value: unknown } | undefined {
  const snapshot = value as ChildSnapshot & { __interrupt__?: Array<{ value: unknown }> };
  return snapshot.__interrupt__?.[0] ?? snapshot.tasks?.flatMap((task) => task.interrupts ?? [])[0];
}

/** Invoke an independently checkpointed attempt, outside the parent graph's inherited config. */
export async function invokeDurableChildGraph(
  graphValue: unknown,
  input: SpawnSubagentInput,
  options: SpawnSubagentOptions,
  invocationConfig: unknown = {},
): Promise<unknown> {
  const execution = options.childExecution;
  if (!execution || !options.durable) throw new Error('Durable child attempt context is required');
  const graph = graphValue as ChildGraph;
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
    durability: 'sync',
  };
  // LangGraph merges the ambient runnable config even when explicit configurable is given.
  // Replacing that ambient context also prevents nested graph read/checkpointer/namespace inheritance.
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
    // A crash can occur after the next interrupt was checkpointed but before its request was saved.
    // Never reuse an approval for a different committed checkpoint.
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
      // This call deliberately uses the restored parent graph context, outside isolated().
      response = interrupt(state.request);
      if (typeof marker === 'string') {
        // A failed parent task can retain an old unscoped response in addition to
        // its positional history. Only a response naming the current retry is fresh.
        while ((history.length > 0 || (response as { durableApprovalId?: unknown } | null)?.durableApprovalId !== undefined) &&
          (response as { durableApprovalId?: unknown } | null)?.durableApprovalId !== marker) {
          response = interrupt(state.request);
        }
      }
      history.push({ request: state.request, response });
      await save({ review: { ...state, response, history } });
    }
    // The tool guard can identify a later retry even when native interrupt IDs reuse a task ID.
    const childResponse = typeof marker === 'string' && typeof response === 'object' && response !== null
      ? { ...response, durableApprovalId: marker } : response;
    return new Command({ resume: childResponse });
  };
  try {
    if (!execution.background) {
      // Parent interrupt responses are positional. Consume the slots already used by this
      // spawn invocation before transferring a newer child request into the same parent task.
      for (const previous of history) interrupt(previous.request);
    }
    let snapshot = await isolated(() => graph.getState(config as never)) as ChildSnapshot;
    const checkpointExists = snapshot.config?.configurable?.checkpoint_id !== undefined;
    if (checkpointExists && (snapshot.metadata?.child_id !== record.id ||
      snapshot.metadata?.child_attempt !== record.attempt || snapshot.metadata?.business_run_id !== options.runId)) {
      throw new Error('Child checkpoint belongs to a different invocation');
    }
    let graphInput: unknown = checkpointExists ? null : { messages: [new HumanMessage(input.task)] };
    const paused = firstInterrupt(snapshot);
    if (paused) graphInput = await approval(paused.value, snapshot.config?.configurable?.checkpoint_id);
    while (true) {
      const result = await isolated(() => graph.invoke(graphInput as never, config as never));
      snapshot = await isolated(() => graph.getState(config as never)) as ChildSnapshot;
      const paused = firstInterrupt(result) ?? firstInterrupt(snapshot);
      if (!paused) return result;
      graphInput = await approval(paused.value, snapshot.config?.configurable?.checkpoint_id);
    }
  } catch (error) {
    throw durableChildFailure(error);
  }
}
