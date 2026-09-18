import type { MemoryNamespaceInput } from './types.js';

const SENSITIVE_PATTERNS = [
  /(?:api[_ -]?key|access[_ -]?token|secret|private[_ -]?key)\s*[:=]\s*\S+/iu,
  /\b(?:sk|pk)[-_][a-z0-9_-]{12,}\b/iu,
  /\b(?:ghp|github_pat|xox[baprs])-[a-z0-9_-]{8,}\b/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/iu,
];

export function memoryNamespace(input: MemoryNamespaceInput): string[] {
  return [
    'keen-ai',
    'v1',
    input.tenantId,
    input.userId,
    input.assistantKey,
    input.scope,
  ];
}

export function isSensitiveMemory(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content));
}

export function clampMemoryText(content: string, maxChars = 4_000): string {
  // 保留 profile 的 Markdown 换行，同时压缩单行内部的重复空白。
  const normalized = content
    .split(/\r?\n/gu)
    .map((line) => line.replaceAll(/[ \t]+/gu, ' ').trimEnd())
    .join('\n')
    .trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
