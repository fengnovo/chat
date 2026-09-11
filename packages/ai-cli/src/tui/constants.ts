// 非 TTY 环境（如管道、CI）不激活 useInput，避免 Raw mode 报错。
export const IS_TTY = process.stdin.isTTY ?? false;

export const SEP = '─'.repeat(72);

export const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  strike: '\x1b[9m',
} as const;
