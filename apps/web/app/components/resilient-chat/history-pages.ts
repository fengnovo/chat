export function prependHistoryMessages<T extends { id: string }>(current: T[], older: T[]): T[] {
  const ids = new Set(current.map((message) => message.id));
  return [...older.filter((message) => !ids.has(message.id)), ...current];
}

type RecoveryMessage = { id: string; role: string; metadata?: { runId?: string } };

export function reconcileRecoveredHistory<T extends RecoveryMessage>(
  current: T[], history: T[], recoveredRunId: string, sentUserRuns: ReadonlyMap<string, string> = new Map(),
): T[] {
  const runId = (message: RecoveryMessage) => sentUserRuns.get(message.id) ?? message.metadata?.runId ??
    (/^(user|message)-/.test(message.id) ? message.id.replace(/^(user|message)-/, '') : undefined);
  const userRuns = new Set(history.filter((message) => message.role === 'user').map(runId));
  const replacedUsers = new Set<string>();
  let pendingUser: T | undefined;
  for (const message of current) {
    if (message.role === 'user') {
      pendingUser = message;
      if (userRuns.has(runId(message))) replacedUsers.add(message.id);
    } else if (message.role === 'assistant' && pendingUser) {
      // 第一条助手回复用于识别乐观创建的用户 run。按文本匹配会错误合并不同轮次中
      // 重复提出的问题。
      if (userRuns.has(runId(message))) replacedUsers.add(pendingUser.id);
      pendingUser = undefined;
    }
  }
  // 首个助手帧到达客户端前，响应可能已经完成。
  if (pendingUser && userRuns.has(recoveredRunId)) replacedUsers.add(pendingUser.id);
  return prependHistoryMessages(history, current.filter((message) => !replacedUsers.has(message.id)));
}
