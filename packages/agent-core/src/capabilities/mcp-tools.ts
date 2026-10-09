/** External names never replace platform handlers or inherit their replay policy. */
const RESERVED_MCP_TOOL_NAMES = new Set([
  'ls', 'read_file', 'write_file', 'edit_file', 'delete', 'glob', 'grep', 'execute',
  'write_todos', 'task', 'start_async_task', 'check_async_task', 'update_async_task',
  'cancel_async_task', 'list_async_tasks', 'spawn_subagent', 'ask_user',
  'preview_page', 'remember_fact', 'forget_memory',
]);

export function reservedMcpToolNames(): string[] { return [...RESERVED_MCP_TOOL_NAMES].sort(); }

export function filterReservedMcpTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((item) => !RESERVED_MCP_TOOL_NAMES.has(item.name));
}
