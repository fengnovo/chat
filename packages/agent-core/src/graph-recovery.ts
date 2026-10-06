import { AIMessage, type BaseMessage } from '@langchain/core/messages';

export interface RecoverySnapshot {
  metadata?: Record<string, unknown> | undefined;
  tasks?: readonly { interrupts?: readonly unknown[] | undefined }[] | undefined;
}

/** null resumes the latest committed graph; a different business run needs fresh input. */
export function chooseRecoveryInput(
  snapshot: RecoverySnapshot,
  runId: string,
  initialInput: unknown,
  savedResumeCommand?: unknown,
): unknown {
  const owned = snapshot.metadata?.business_run_id === runId || snapshot.metadata?.run_id === runId;
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
