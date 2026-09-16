import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);

const ports = [...new Set(['PORT', 'API_PORT'].map((name) => {
  const value = process.env[name];
  if (!value) throw new Error(`[dev] ${name} must be set in .env`);

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`[dev] ${name} must be a valid TCP port`);
  }
  return port;
}))];

function listeningPids(port) {
  try {
    return execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

for (const port of ports) {
  for (const pid of listeningPids(port)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`[dev] released port ${port} (PID ${pid})`);
    } catch {
      // The process may have exited between lsof and SIGTERM.
    }
  }
}

console.log(`[dev] ports ready: ${ports.join(', ')}`);

// Worker 不监听端口，端口清理管不到它；而多个 worker 同时连同一个 Redis 队列会
// 随机瓜分任务（新旧代码/配置不一致时就出现"MCP 工具有时有时无"）。
// 这里按"命令行匹配 + cwd 属于本仓库"精确收割残留 worker（含 tsx --watch 父子进程）。
function matchingPids(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
      .split(/\s+/)
      .map(Number)
      .filter(Boolean)
      .filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
}

function cwdOf(pid) {
  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1);
  } catch {
    return undefined;
  }
}

const workerCwd = join(repositoryRoot, 'apps', 'worker');
for (const pid of matchingPids('src/worker\\.ts')) {
  if (cwdOf(pid) !== workerCwd) continue;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[dev] released stale worker PID ${pid} (${workerCwd})`);
  } catch {
    // 进程可能在 pgrep 与 kill 之间退出。
  }
}
