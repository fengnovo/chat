import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CliArgs {
  cwd: string;
  oneShotTask: string | null;
}

export interface CliSettings extends CliArgs {
  projectDir: string;
  skillsHostDir: string;
  mcpConfigPath: string;
  memoryHostFile: string;
  skillCount: number;
}

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.resolve(sourceDir, '..');

/** 解析 CLI 参数。显式传参让这段逻辑可以脱离进程环境单独测试。 */
export function parseCliArgs(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CliArgs {
  let cwd = env.CODE_AGENT_CWD?.trim() || path.join(projectDir, 'workspace');
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && argv[i + 1]) {
      cwd = path.resolve(argv[i + 1]);
      i++;
    } else {
      positional.push(argv[i]);
    }
  }

  return {
    cwd,
    oneShotTask: positional.length > 0 ? positional.join(' ') : null,
  };
}

export function countSkills(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'SKILL.md')),
  ).length;
}

/** 汇总启动所需路径，目录创建集中在 CLI 组合层。 */
export function createCliSettings(): CliSettings {
  const args = parseCliArgs();
  mkdirSync(args.cwd, { recursive: true });

  const skillsHostDir = path.join(projectDir, 'skills');
  return {
    ...args,
    projectDir,
    skillsHostDir,
    mcpConfigPath: path.join(projectDir, 'mcp', 'mcp.json'),
    memoryHostFile: path.join(projectDir, 'AGENTS.md'),
    skillCount: countSkills(skillsHostDir),
  };
}
