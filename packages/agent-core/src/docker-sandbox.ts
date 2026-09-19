import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from 'deepagents';

const DEFAULT_IMAGE = 'chat-agent-sandbox:latest';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
const MAX_COMMAND_LENGTH = 30_000;
const MAX_OUTPUT_FILES = 20;
const MAX_OUTPUT_TREE_ENTRIES = 2_000;
const MAX_OUTPUT_TREE_DEPTH = 20;
const MAX_OUTPUT_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_PREVIEW_COUNT = 5;
const MAX_PREVIEW_FILES = 2_000;
const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
const CONTAINER_USER = '65532:65532';
const IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;

/**
 * 沙箱内不可被 shell 命令修改的关键路径前缀（容器内视角）。
 * 用于对破坏性命令做前置告警（纵深防御；真正的拦截由只读 bind mount 保证）。
 */
const PROTECTED_CONTAINER_PATHS: readonly string[] = [
  '/mnt/user-data',
  '/mnt/user-data/workspace',
  '/mnt/user-data/outputs',
  '/mnt/user-data/previews',
  '/skills',
  '/mnt/skills',
  '/large_tool_results',
];

/**
 * 检测 shell 命令是否包含针对关键路径的破坏性操作（rm / mv / chmod / chown）。
 * 仅用于审计日志，不阻断执行——内核级只读挂载才是真正的安全边界。
 */
const detectDangerousCommand = (command: string): string | null => {
  // 按管道/分号/逻辑运算符拆分命令片段，逐段检测
  const segments = command.split(/[|;&]/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const cmd = tokens[0];
    // 支持 sudo 前缀（虽然容器内无 sudo，但防御应覆盖）
    const effectiveCmd = cmd === 'sudo' ? tokens[1] : cmd;
    if (effectiveCmd !== 'rm' && effectiveCmd !== 'mv' &&
        effectiveCmd !== 'chmod' && effectiveCmd !== 'chown') {
      continue;
    }
    for (const token of tokens) {
      for (const protectedPath of PROTECTED_CONTAINER_PATHS) {
        if (token === protectedPath || token.startsWith(`${protectedPath}/`)) {
          return `${effectiveCmd} ${token}`;
        }
      }
    }
  }
  return null;
};

/** 默认沙箱会话根；位于仓库 data 目录下，已被 .gitignore 忽略。 */
const DEFAULT_SESSIONS_ROOT = fileURLToPath(
  new URL('../../../data/sandboxes', import.meta.url),
);

/** 沙箱可用的工作区根目录，也是模型看到的容器内工作目录。 */
export const DOCKER_SANDBOX_WORKSPACE = '/mnt/user-data/workspace';

/** 需要注入沙箱 /skills 目录的技能包。 */
export interface SandboxSkill {
  name: string;
  files: Array<{ relativePath: string; content: Uint8Array | string }>;
}

export interface DockerSandboxOptions {
  /** 可信调用方提供的会话标识；只用于隔离本轮临时目录。 */
  sessionId?: string;
  /** 部署或测试时覆盖沙箱会话根，不能来自模型或普通聊天请求。 */
  rootDirectory?: string;
  /** Docker 镜像名，默认 chat-agent-sandbox:latest。 */
  image?: string;
  /** 单次 execute 超时；实现会限制在 1 秒到 10 分钟之间。 */
  commandTimeoutMs?: number;
  /** 返回给模型的 stdout/stderr 上限，文件内容不受此字段控制。 */
  maxOutputBytes?: number;
}

/** Docker 沙箱中由 Agent 写入 outputs 目录的候选产物。 */
export interface SandboxOutputFile {
  absolutePath: string;
  relativePath: string;
  name: string;
  size: number;
}

/** previews 下一个包含 index.html 的可发布静态网站目录。 */
export interface SandboxPreviewDirectory {
  absolutePath: string;
  name: string;
  fileCount: number;
  size: number;
}

/** 判断规范化后的宿主路径是否仍位于本轮受信根目录内。 */
const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..')
  );
};

const toFileError = (error: unknown): FileOperationError => {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'ENOENT') return 'file_not_found';
    if (error.code === 'EISDIR') return 'is_directory';
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return 'permission_denied';
    }
  }

  return 'invalid_path';
};

const appendBounded = (
  current: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  limit: number,
): void => {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }

  const remaining = limit - state.bytes;
  const accepted = chunk.subarray(0, remaining);
  current.push(accepted);
  state.bytes += accepted.byteLength;
  if (accepted.byteLength < chunk.byteLength) state.truncated = true;
};

/**
 * 普通本地 Docker 容器沙箱。
 * 每次 execute 都启动一个短生命周期容器，通过受限 bind mount 复用本轮工作区。
 * 容器无网络、只读根文件系统、丢弃全部 capability，且不能访问宿主 Docker socket。
 */
export class DockerSandboxBackend extends BaseSandbox {
  readonly id: string;
  /** DeepAgent 看到的工作区根；它与仓库源码目录没有任何映射关系。 */
  readonly rootDir = '/mnt/user-data';

  private readonly sessionRoot: string;
  private readonly userDataRoot: string;
  private readonly workspaceRoot: string;
  private readonly outputsRoot: string;
  private readonly previewsRoot: string;
  private readonly largeResultsRoot: string;
  private readonly skillsRoot: string;
  private readonly image: string;
  private readonly commandTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private closed = false;

  private constructor(options: DockerSandboxOptions) {
    super();
    // sessionId 只用于生成服务端目录和容器名称，不允许成为任意宿主路径。
    const normalizedSessionId = (options.sessionId || randomUUID())
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 120);
    const sessionId = normalizedSessionId || randomUUID();
    const sessionsRoot = resolve(options.rootDirectory || DEFAULT_SESSIONS_ROOT);

    this.id = `docker-${sessionId}`;
    this.sessionRoot = join(sessionsRoot, sessionId);
    // 只有 user-data 会作为可写 bind mount 暴露给容器。仓库、.env 和进程 cwd
    // 从未出现在 docker run 的挂载参数中。
    this.userDataRoot = join(this.sessionRoot, 'user-data');
    this.workspaceRoot = join(this.userDataRoot, 'workspace');
    this.outputsRoot = join(this.userDataRoot, 'outputs');
    this.previewsRoot = join(this.userDataRoot, 'previews');
    this.largeResultsRoot = join(this.userDataRoot, 'large-tool-results');
    this.skillsRoot = join(this.sessionRoot, 'skills');
    this.image = options.image?.trim() || DEFAULT_IMAGE;
    if (!IMAGE_REFERENCE_PATTERN.test(this.image)) {
      throw new Error(`Docker 沙箱镜像名称无效：${this.image}`);
    }
    this.commandTimeoutMs = Math.min(
      Math.max(options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
      600_000,
    );
    this.maxOutputBytes = Math.min(
      Math.max(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1_024),
      1_000_000,
    );
  }

  static async create(
    options: DockerSandboxOptions,
    skills: SandboxSkill[] = [],
  ): Promise<DockerSandboxBackend> {
    const backend = new DockerSandboxBackend(options);
    try {
      await backend.initialize(skills);
      return backend;
    } catch (error) {
      await backend.destroy().catch(() => undefined);
      throw error;
    }
  }

  private async initialize(skills: SandboxSkill[]): Promise<void> {
    // 目录按“工作源码 / 下载产物 / 静态预览 / 大工具结果”分区，方便发布器
    // 只扫描明确出口，而不是遍历整个模型工作区。
    await Promise.all([
      mkdir(this.workspaceRoot, { recursive: true, mode: 0o777 }),
      mkdir(this.outputsRoot, { recursive: true, mode: 0o777 }),
      mkdir(this.previewsRoot, { recursive: true, mode: 0o777 }),
      mkdir(this.largeResultsRoot, { recursive: true, mode: 0o777 }),
      mkdir(this.skillsRoot, { recursive: true, mode: 0o755 }),
    ]);
    // Docker Desktop 会保留 bind mount 的权限；工作区允许容器内的非特权用户写入。
    await Promise.all([
      chmod(this.userDataRoot, 0o777),
      chmod(this.workspaceRoot, 0o777),
      chmod(this.outputsRoot, 0o777),
      chmod(this.previewsRoot, 0o777),
      chmod(this.largeResultsRoot, 0o777),
    ]);

    for (const skill of skills) {
      const skillRoot = join(this.skillsRoot, skill.name);
      await mkdir(skillRoot, { recursive: true, mode: 0o755 });

      for (const file of skill.files) {
        const target = resolve(skillRoot, file.relativePath);
        if (!isWithin(skillRoot, target)) {
          throw new Error(`Skill 文件路径越界：${file.relativePath}`);
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, file.content, { mode: 0o444 });
      }
    }
  }

  /**
   * 命令作为 docker run 的普通参数传入容器 shell，绝不会由宿主 shell 解释。
   * 容器没有网络、Docker socket、宿主环境变量或仓库挂载。
   */
  async execute(command: string): Promise<ExecuteResponse> {
    if (this.closed) {
      return { output: 'Docker 沙箱已经关闭。', exitCode: 1, truncated: false };
    }
    if (!command.trim()) {
      return { output: '命令不能为空。', exitCode: 2, truncated: false };
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      return {
        output: `命令长度超过 ${MAX_COMMAND_LENGTH} 个字符。`,
        exitCode: 2,
        truncated: false,
      };
    }

    // 纵深防御：检测针对关键路径的破坏性命令并记录告警。
    // 真正的拦截由 /mnt/user-data 的只读 bind mount 保证，这里仅用于审计日志。
    const dangerousHit = detectDangerousCommand(command);
    if (dangerousHit) {
      console.warn(
        `[DockerSandbox] 检测到破坏性命令（沙箱 ${this.id}）: ${dangerousHit} ← ${command.slice(0, 200)}`,
      );
    }

    const containerName = `${this.id}-${randomUUID().slice(0, 8)}`
      .toLowerCase()
      .slice(0, 63);
    // 每个 execute 创建一个新容器；所有容器只通过本轮 user-data 共享状态。
    // 这样不会保留后台进程，同时仍允许“写源码 → 构建 → 收集产物”的多步任务。
    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--ulimit',
      'fsize=104857600:104857600',
      '--memory',
      '768m',
      '--cpus',
      '1.5',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=128m',
      '--user',
      CONTAINER_USER,
      '--env',
      'HOME=/tmp',
      '--env',
      'PYTHONDONTWRITEBYTECODE=1',
      '--workdir',
      DOCKER_SANDBOX_WORKSPACE,
      // /mnt/user-data 父目录只读：禁止 mv/rm 等对目录结构本身的修改。
      // 各子目录通过独立的可写 bind mount 覆盖，文件读写不受影响。
      '--mount',
      `type=bind,src=${this.userDataRoot},dst=/mnt/user-data,ro`,
      '--mount',
      `type=bind,src=${this.workspaceRoot},dst=/mnt/user-data/workspace`,
      '--mount',
      `type=bind,src=${this.outputsRoot},dst=/mnt/user-data/outputs`,
      '--mount',
      `type=bind,src=${this.previewsRoot},dst=/mnt/user-data/previews`,
      '--mount',
      `type=bind,src=${this.skillsRoot},dst=/skills,readonly`,
      '--mount',
      `type=bind,src=${this.skillsRoot},dst=/mnt/skills/public,readonly`,
      '--mount',
      `type=bind,src=${this.largeResultsRoot},dst=/large_tool_results`,
      this.image,
      '/bin/bash',
      '-lc',
      command,
    ];

    return new Promise((resolveExecution) => {
      const child = spawn('docker', args, {
        env: {
          PATH: process.env.PATH,
          DOCKER_HOST: process.env.DOCKER_HOST,
          DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      const outputState = { bytes: 0, truncated: false };
      let timedOut = false;
      let settled = false;

      const collect = (chunk: Buffer) =>
        appendBounded(output, chunk, outputState, this.maxOutputBytes);
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        const cleanup = spawn('docker', ['rm', '--force', containerName], {
          stdio: 'ignore',
        });
        cleanup.unref();
      }, this.commandTimeoutMs);

      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        let text = Buffer.concat(output).toString('utf8');
        if (spawnError) text += `${text ? '\n' : ''}${spawnError.message}`;
        if (timedOut) {
          text += `${text ? '\n' : ''}命令执行超过 ${this.commandTimeoutMs}ms，已终止容器。`;
        }
        resolveExecution({
          output: text || (exitCode === 0 ? '命令执行成功。' : '命令执行失败。'),
          exitCode: timedOut ? 124 : exitCode,
          truncated: outputState.truncated,
        });
      };

      child.once('error', (error) => finish(127, error));
      child.once('close', (code) => finish(code));
    });
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    // BaseSandbox 的 write/edit 最终会走这个适配器。这里写的是服务端创建的
    // 会话暂存目录，不是调用进程 cwd，更不会接受任意宿主绝对路径。
    return Promise.all(
      files.map(async ([filePath, content]) => {
        try {
          const target = await this.resolveHostPath(filePath, true);
          await mkdir(dirname(target), { recursive: true, mode: 0o777 });
          await writeFile(target, content, { mode: 0o666 });
          return { path: filePath, error: null };
        } catch (error) {
          return { path: filePath, error: toFileError(error) };
        }
      }),
    );
  }

  /** 在进入 BaseSandbox 工具前校验受限写入路径。 */
  async assertWritablePath(filePath: string): Promise<void> {
    await this.resolveHostPath(filePath, true);
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    // 二进制读取和 edit 的读阶段会走这里；符号链接必须在读取前拒绝，
    // 避免容器先创建链接再诱导宿主适配器读取链接目标。
    return Promise.all(
      paths.map(async (filePath) => {
        try {
          const target = await this.resolveHostPath(filePath, false);
          const info = await lstat(target);
          if (info.isDirectory()) {
            return { path: filePath, content: null, error: 'is_directory' };
          }
          if (info.isSymbolicLink()) {
            return { path: filePath, content: null, error: 'invalid_path' };
          }
          return {
            path: filePath,
            content: new Uint8Array(await readFile(target)),
            error: null,
          };
        } catch (error) {
          return { path: filePath, content: null, error: toFileError(error) };
        }
      }),
    );
  }

  /**
   * 在模型结束后扫描唯一允许的下载出口 outputs。
   * 这里只返回候选元数据，真正的持久复制和 URL 签发由调用方发布器完成。
   */
  async listOutputFiles(): Promise<SandboxOutputFile[]> {
    const results: SandboxOutputFile[] = [];
    let entryCount = 0;
    let totalBytes = 0;

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_OUTPUT_TREE_DEPTH) {
        throw new Error(`产物目录层级不能超过 ${MAX_OUTPUT_TREE_DEPTH} 层`);
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > MAX_OUTPUT_TREE_ENTRIES) {
          throw new Error(`产物目录包含超过 ${MAX_OUTPUT_TREE_ENTRIES} 个条目`);
        }
        const absolutePath = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await visit(absolutePath, depth + 1);
        } else if (entry.isFile()) {
          const info = await lstat(absolutePath);
          totalBytes += info.size;
          if (results.length >= MAX_OUTPUT_FILES) {
            throw new Error(`每轮最多发布 ${MAX_OUTPUT_FILES} 个产物`);
          }
          if (totalBytes > MAX_OUTPUT_TOTAL_BYTES) {
            throw new Error('本轮产物总大小不能超过 250 MB');
          }
          const relativePath = relative(this.outputsRoot, absolutePath);
          results.push({
            absolutePath,
            relativePath,
            name: basename(relativePath),
            size: info.size,
          });
        }
      }
    };

    await visit(this.outputsRoot, 0);
    return results.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }

  /**
   * 只把 previews 的一级子目录作为网站；每个目录必须包含普通 index.html。
   * 发布前完整遍历并拒绝符号链接、过深目录和超限站点。
   */
  async listPreviewDirectories(): Promise<SandboxPreviewDirectory[]> {
    const candidates = await readdir(this.previewsRoot, {
      withFileTypes: true,
    });
    const previews: SandboxPreviewDirectory[] = [];

    for (const candidate of candidates) {
      if (candidate.isSymbolicLink() || !candidate.isDirectory()) continue;
      if (previews.length >= MAX_PREVIEW_COUNT) {
        throw new Error(`每轮最多发布 ${MAX_PREVIEW_COUNT} 个网站预览`);
      }

      const previewRoot = join(this.previewsRoot, candidate.name);
      const indexInfo = await lstat(join(previewRoot, 'index.html')).catch(
        () => undefined,
      );
      if (!indexInfo?.isFile() || indexInfo.isSymbolicLink()) {
        throw new Error(`网站预览 ${candidate.name} 缺少普通 index.html`);
      }

      let fileCount = 0;
      let size = 0;
      const visit = async (directory: string, depth: number): Promise<void> => {
        if (depth > MAX_OUTPUT_TREE_DEPTH) {
          throw new Error(
            `网站预览 ${candidate.name} 目录层级不能超过 ${MAX_OUTPUT_TREE_DEPTH} 层`,
          );
        }

        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const absolutePath = join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            throw new Error(`网站预览不能包含符号链接：${entry.name}`);
          }
          if (entry.isDirectory()) {
            await visit(absolutePath, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;

          fileCount += 1;
          if (fileCount > MAX_PREVIEW_FILES) {
            throw new Error(
              `网站预览 ${candidate.name} 不能超过 ${MAX_PREVIEW_FILES} 个文件`,
            );
          }
          size += (await lstat(absolutePath)).size;
          if (size > MAX_PREVIEW_BYTES) {
            throw new Error(`网站预览 ${candidate.name} 总大小不能超过 100 MB`);
          }
        }
      };

      await visit(previewRoot, 0);
      previews.push({
        absolutePath: previewRoot,
        name: candidate.name,
        fileCount,
        size,
      });
    }

    return previews.sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * 释放本轮沙箱句柄。容器本身是 --rm 短生命周期，无需额外清理；
   * 工作区目录保留，供同一会话的后续消息继续使用。
   */
  async close(): Promise<void> {
    this.closed = true;
  }

  /** 关闭沙箱并删除本轮工作区，用于取消或失败的会话。 */
  async destroy(): Promise<void> {
    this.closed = true;
    await rm(this.sessionRoot, { recursive: true, force: true });
  }

  private async resolveHostPath(
    sandboxPath: string,
    writable: boolean,
  ): Promise<string> {
    // DeepAgent 偶尔会给 upload/download 传相对路径。它们始终相对于容器的
    // 默认工作目录解析，绝不能相对于进程的 process.cwd() 解析。
    const normalized = posix.normalize(
      sandboxPath.startsWith('/')
        ? sandboxPath
        : `${DOCKER_SANDBOX_WORKSPACE}/${sandboxPath}`,
    );
    let root: string;
    let suffix: string;

    if (
      normalized === '/mnt/user-data' ||
      normalized.startsWith('/mnt/user-data/')
    ) {
      root = this.userDataRoot;
      suffix = normalized.slice('/mnt/user-data'.length);
    } else if (
      normalized === '/large_tool_results' ||
      normalized.startsWith('/large_tool_results/')
    ) {
      root = this.largeResultsRoot;
      suffix = normalized.slice('/large_tool_results'.length);
    } else if (
      normalized === '/skills' ||
      normalized.startsWith('/skills/')
    ) {
      if (writable) {
        throw Object.assign(new Error('Skill 目录只读'), { code: 'EACCES' });
      }
      root = this.skillsRoot;
      suffix = normalized.slice('/skills'.length);
    } else if (
      normalized === '/mnt/skills/public' ||
      normalized.startsWith('/mnt/skills/public/')
    ) {
      if (writable) {
        throw Object.assign(new Error('Skill 目录只读'), { code: 'EACCES' });
      }
      root = this.skillsRoot;
      suffix = normalized.slice('/mnt/skills/public'.length);
    } else {
      throw Object.assign(new Error(`不允许访问路径：${sandboxPath}`), {
        code: 'EINVAL',
      });
    }

    const target = resolve(root, `.${suffix}`);
    if (!isWithin(root, target)) {
      throw Object.assign(new Error(`路径越界：${sandboxPath}`), {
        code: 'EINVAL',
      });
    }

    // 防止容器创建的符号链接在宿主侧 upload/download 时逃逸沙箱根目录。
    let cursor = root;
    const parts = relative(root, target)
      .split(sep)
      .filter(Boolean);
    for (const part of parts) {
      cursor = join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (
          info.isSymbolicLink() ||
          (writable && info.isFile() && info.nlink > 1)
        ) {
          throw Object.assign(
            new Error('不允许通过符号链接或硬链接别名写入文件'),
            { code: 'EINVAL' },
          );
        }
      } catch (error) {
        if (
          writable &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          break;
        }
        throw error;
      }
    }

    return target;
  }
}
