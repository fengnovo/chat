import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { firstGraphInterrupt, type GraphSnapshot } from './adapters/langgraph.js';
import type { AgentResumeInput } from './types.js';
export { adaptLangGraph, readGraphSnapshot, firstGraphInterrupt } from './adapters/langgraph.js';
export type { GraphSnapshot, GraphExecutionConfig, GraphInterruptValue, AgentStreamEvent } from './adapters/langgraph.js';

export interface RecoverySnapshot {
  metadata?: Record<string, unknown> | undefined;
  tasks?: readonly { interrupts?: readonly unknown[] | undefined }[] | undefined;
}

export function checkpointBelongsToRun(snapshot: RecoverySnapshot, runId: string): boolean {
  return snapshot.metadata?.business_run_id === runId || snapshot.metadata?.run_id === runId;
}

/** Restore only the answer addressed to the currently committed interrupt/retry. */
export function createRecoveryResumeCommand(snapshot: GraphSnapshot, input: AgentResumeInput): Command | undefined {
  const pending = firstGraphInterrupt(snapshot);
  if (!pending) return undefined;
  const value = pending.value;
  const request = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  const marker = typeof request?.durableApprovalId === 'string' ? request.durableApprovalId : undefined;
  const pendingId = marker ?? pending.id;
  if (input.interruptId && pendingId && input.interruptId !== pendingId) return undefined;
  if (input.kind === 'question') return new Command({ resume: input.answer });
  const count = Math.max(1, Array.isArray(request?.actionRequests) ? request.actionRequests.length : 0);
  return new Command({ resume: {
    ...(marker ? { durableApprovalId: marker } : {}),
    decisions: Array.from({ length: count }, () => input.decision === 'approve'
      ? { type: 'approve' } : { type: 'reject', message: input.message ?? '用户拒绝操作' }),
  } });
}

/** null resumes the latest committed graph; a different business run needs fresh input. */
export function chooseRecoveryInput(
  snapshot: RecoverySnapshot,
  runId: string,
  initialInput: unknown,
  savedResumeCommand?: unknown,
): unknown {
  const owned = checkpointBelongsToRun(snapshot, runId);
  if (!owned) {
    if (savedResumeCommand !== undefined) throw new Error('Cannot resume: checkpoint does not belong to this run');
    return initialInput;
  }
  const interrupted = snapshot.tasks?.some((task) => (task.interrupts?.length ?? 0) > 0);
  return interrupted && savedResumeCommand !== undefined ? savedResumeCommand : null;
}

/** Use committed messages to repair partial token streams after model node replay. */
export function canonicalAssistantText(messages: readonly BaseMessage[] | undefined, runId: string): string {
  if (!messages) return '';
  const start = messages.findIndex((message) => message.id === `user-${runId}`);
  const candidates = start < 0 ? messages.slice(-1) : messages.slice(start + 1);
  return candidates.filter((message) => AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) === 0)
    .map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => 'text' in part ? String(part.text) : '').join(''))
    .join('\n\n');
}
