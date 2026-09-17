import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';
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

/** 释放端口：SIGTERM 宽限 + SIGKILL 兜底，并验证 LISTEN 真正消失（避免新栈 EADDRINUSE）。 */
function releasePorts() {
  for (const port of ports) {
    for (const pid of listeningPids(port)) {
      const exited = terminateProcess(Number(pid));
      if (exited) {
        console.log(`[dev] released port ${port} (PID ${pid})`);
      } else {
        throw new Error(
          `[dev] port ${port} is still held by PID ${pid} after SIGTERM/SIGKILL; ` +
            `please free it manually (sudo kill -9 ${pid}) and retry.`,
        );
      }
    }
  }
  console.log(`[dev] ports ready: ${ports.join(', ')}`);
}

/**
 * Worker 不监听端口，端口清理管不到它；而多个 worker 同时连同一个 Redis 队列会
 * 随机瓜分任务（新旧代码/配置不一致时就出现「MCP 工具有时有时无」、日志对不上）。
 *
 * 残留来源：tsx --watch 异常重启留下的孤儿、手动跑过 dev:worker 忘关、IDE 起的进程等。
 * 这里在 dev 启动前检测本仓库所有形态的残留 worker（watch 父子进程 / tsx 直跑 /
 * dist 构建产物），醒目提示并经确认后收割；杀不掉的给出手动命令。
 */

// 兼容三种形态：相对路径「--watch src/worker.ts」（src 前是空格）、
// 绝对路径「…/apps/worker/src/worker.ts」、构建产物 dist/worker.js。
const WORKER_ENTRY_PATTERN =
  /(?:^|[\s/\\])(?:apps[/\\]worker[/\\])?(?:src[/\\]worker\.ts|dist[/\\]worker\.js)(?:\s|$)/;
const CONFIRM_TIMEOUT_MS = 15_000;
const TERM_GRACE_MS = 3_000;

function pgrepWorkerCandidates() {
  // 宽匹配入口文件名（dev 进程命令行是相对路径「src/worker.ts」，不带 apps/worker 前缀，
  // pnpm 包装层更是只显示 filter 名）；命中后再用入口正则 + cwd 双重确认防误杀。
  try {
    return execFileSync('pgrep', ['-f', 'worker\\.(ts|js)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\s+/)
      .map(Number)
      .filter(Boolean)
      .filter((pid) => pid !== process.pid);
  } catch {
    // pgrep 无匹配时退出码为 1。
    return [];
  }
}

function processDetails(pid) {
  try {
    const line = execFileSync('ps', ['-o', 'etime=,state=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!line) return undefined;
    // etime（如 1:23:45 / 2:10）与 state 是单段，其余整行是命令行。
    const match = line.match(/^(\S+)\s+(\S+)\s+(.*)$/s);
    if (!match) return undefined;
    return { elapsed: match[1], state: match[2], command: match[3] };
  } catch {
    return undefined;
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

function isWithinRepository(path) {
  return path === repositoryRoot || path.startsWith(`${repositoryRoot}/`);
}

/** 列出确认属于本仓库的残留 worker：命令行命中 worker 入口 + cwd/命令行落在仓库内。 */
function listStaleWorkers() {
  const stale = [];
  for (const pid of pgrepWorkerCandidates()) {
    const details = processDetails(pid);
    if (!details || !WORKER_ENTRY_PATTERN.test(details.command)) continue;
    const cwd = cwdOf(pid);
    const belongsToRepo =
      (cwd && isWithinRepository(cwd)) || details.command.includes(repositoryRoot);
    if (!belongsToRepo) continue;
    stale.push({ pid, ...details, cwd });
  }
  return stale;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // 存活但无权限（本仓库进程不应出现，按存活处理）
  }
}

function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    // 同步小步等待，启动脚本无需引入异步 sleep。
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 200);
  }
  return !isAlive(pid);
}

/** SIGTERM 宽限后仍存活则 SIGKILL 兜底；返回最终是否已退出。 */
function terminateProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isAlive(pid);
  }
  if (waitForExit(pid, TERM_GRACE_MS)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return !isAlive(pid);
  }
  return waitForExit(pid, 1_000);
}

async function confirmCleanup(count) {
  // 非交互环境（IDE 任务、CI）直接清理，避免 question 永远挂起。
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let answer;
    try {
      answer = await Promise.race([
        rl.question(`是否清理这些残留进程并启动 dev 栈？[Y/n]（${Math.round(CONFIRM_TIMEOUT_MS / 1000)}s 后自动清理）：`),
        new Promise((resolve) => setTimeout(() => resolve(null), CONFIRM_TIMEOUT_MS)),
      ]);
    } catch {
      // Ctrl+C / Ctrl+D：用户主动中止，不清理、不启动 dev 栈（&& 链因非零退出中断）。
      process.stdout.write('\n[dev] 已取消，dev 栈未启动。\n');
      process.exit(130);
    }
    if (answer === null) {
      process.stdout.write('\n[dev] 等待超时，自动清理。\n');
      return true;
    }
    return !/^n/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * 主流程：检测残留（worker + 占用端口）→ 确认 → 一次性清理 → 放行新栈。
 * 关键：清理被跳过或有进程杀不掉时必须以非零码退出——package.json 里是
 * `free-dev-ports.mjs && concurrently ...`，非零退出会阻止新栈启动，
 * 否则新 worker 与残留 worker 同时连队列，正是要消除的多 worker 局面。
 */
const staleWorkers = listStaleWorkers();
const occupiedPorts = ports
  .map((port) => ({ port, pids: listeningPids(port) }))
  .filter((item) => item.pids.length > 0);
const blockerCount = staleWorkers.length + occupiedPorts.reduce((sum, item) => sum + item.pids.length, 0);

if (blockerCount > 0) {
  const lines = [
    '┌──────────────────────────────────────────────────────────────┐',
    `│  ⚠ 检测到 ${blockerCount} 个残留进程，启动前需要清理（否则会出现多 worker 抢队列/端口占用）`,
    '├──────────────────────────────────────────────────────────────┤',
  ];
  for (const { port, pids } of occupiedPorts) {
    lines.push(`│  端口 ${port} 占用：PID ${pids.join(', ')}`);
  }
  for (const item of staleWorkers) {
    // 命令行公共前缀都是仓库路径，保留尾段才能看出是 watch 父子进程还是 dist 产物。
    const tail =
      item.command.length > 46 ? `…${item.command.slice(item.command.length - 45)}` : item.command;
    lines.push(
      `│  worker  PID ${String(item.pid).padEnd(7)} 已运行 ${item.elapsed.padEnd(9)} ${tail}`,
    );
  }
  lines.push('└──────────────────────────────────────────────────────────────┘');
  for (const line of lines) console.log(line);

  const shouldClean = await confirmCleanup(blockerCount);
  if (!shouldClean) {
    console.log('[dev] 已取消清理，dev 栈未启动。确认要重启时重新执行 pnpm dev；');
    console.log('[dev] 也可手动清理后重试：');
    console.log(`[dev]   pkill -TERM -f 'src/worker\\.ts|dist/worker\\.js'`);
    process.exit(1);
  }
}

// 确认之后才动手：避免出现「端口已杀、用户却选择跳过」的半破坏状态。
releasePorts();

if (staleWorkers.length > 0) {
  const survivors = [];
  for (const item of staleWorkers) {
    if (item.state === 'Z') {
      survivors.push({ ...item, reason: '僵尸进程（需其父进程退出或重启机器）' });
      continue;
    }
    const exited = terminateProcess(item.pid);
    if (exited) {
      console.log(`[dev] cleaned stale worker PID ${item.pid}`);
    } else {
      survivors.push({ ...item, reason: 'SIGTERM/SIGKILL 后仍存活' });
    }
  }
  if (survivors.length > 0) {
    console.log('[dev] 以下 worker 未能自动清理，dev 栈已阻止启动，请手动处理：');
    for (const item of survivors) {
      console.log(`[dev]   PID ${item.pid}（${item.reason}）：${item.command}`);
    }
    console.log(`[dev]   手动命令：sudo kill -9 ${survivors.map((item) => item.pid).join(' ')}`);
    process.exit(1);
  }
  console.log('[dev] worker 环境干净，启动新的 dev 栈。');
}
