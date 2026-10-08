export type ActivityItem =
  | {
      kind: 'tool';
      invocationId: string;
      tool: string;
      summary: string;
      running: boolean;
      input?: unknown;
      output?: unknown;
      failed?: boolean;
    }
  | { kind: 'note'; summary: string };

function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return tool;
  const record = input as Record<string, unknown>;
  const hint =
    record.file_path ??
    record.path ??
    record.command ??
    record.pattern ??
    record.query ??
    record.url ??
    '';
  return hint ? `${tool} · ${String(hint).slice(0, 80)}` : tool;
}

export function toolStartedItem(
  invocationId: string,
  tool: string,
  input: unknown,
): ActivityItem {
  return {
    kind: 'tool',
    invocationId,
    tool,
    summary: summarizeToolInput(tool, input),
    running: true,
    input,
  };
}

export function formatDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

export function completeTool(
  items: ActivityItem[],
  invocationId: string,
  tool: string,
  output: unknown,
): ActivityItem[] {
  const previous = items.find(
    (item) => item.kind === 'tool' && item.invocationId === invocationId,
  );
  const failed =
    (typeof output === 'object' &&
      output !== null &&
      ((output as { isError?: boolean }).isError === true ||
        (output as { status?: string }).status === 'error')) ||
    /^(Error calling tool|Error:|工具执行失败)/i.test(formatDetail(output));
  const completed: ActivityItem = {
    ...(previous ?? toolStartedItem(invocationId, tool, undefined)),
    kind: 'tool',
    invocationId,
    tool,
    summary: previous?.summary ?? tool,
    running: false,
    output,
    failed,
  };
  return previous
    ? items.map((item) => (item === previous ? completed : item))
    : [...items, completed];
}
