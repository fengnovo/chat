import { CommandExitError, Sandbox } from 'e2b';
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from 'deepagents';

export interface E2BSandboxOptions {
  apiKey: string;
  apiUrl?: string;
  sandboxUrl?: string;
  template?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MAX_OUTPUT_BYTES = 200_000;

function classifyFileError(message: string): FileOperationError {
  const normalized = message.toLowerCase();
  if (normalized.includes('not found') || normalized.includes('no such file')) return 'file_not_found';
  if (normalized.includes('permission') || normalized.includes('denied')) return 'permission_denied';
  if (normalized.includes('is a directory') || normalized.includes('isdir')) return 'is_directory';
  return 'invalid_path';
}

export class E2BSandbox extends BaseSandbox {
  private running = true;

  private constructor(
    private readonly sandbox: Sandbox,
    private readonly signal?: AbortSignal,
  ) {
    super();
  }

  static async create(options: E2BSandboxOptions): Promise<E2BSandbox> {
    const sandbox = await Sandbox.create(options.template ?? 'base', {
      apiKey: options.apiKey,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.sandboxUrl ? { sandboxUrl: options.sandboxUrl } : {}),
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return new E2BSandbox(sandbox, options.signal);
  }

  static async connect(sandboxId: string, options: E2BSandboxOptions): Promise<E2BSandbox> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey: options.apiKey,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.sandboxUrl ? { sandboxUrl: options.sandboxUrl } : {}),
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await sandbox.setTimeout(timeoutMs);
    return new E2BSandbox(sandbox, options.signal);
  }

  get id(): string {
    return this.sandbox.sandboxId;
  }

  getHost(port: number): string {
    return this.sandbox.getHost(port);
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    await this.sandbox.setTimeout(timeoutMs);
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const background = /\bnohup\b|\&\s*$/.test(command);
    if (background) {
      await this.sandbox.commands.run(command, {
        background: true,
        timeoutMs: 0,
        ...(this.signal ? { signal: this.signal } : {}),
      });
      return { output: `[background started] ${command}`, exitCode: 0, truncated: false };
    }

    this.signal?.throwIfAborted();
    const handle = await this.sandbox.commands.run(command, {
      background: true,
      timeoutMs: 180_000,
    });
    const abort = () => {
      void handle.kill().catch(() => undefined);
    };
    this.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (this.signal?.aborted) {
        abort();
        throw this.signal.reason;
      }
      const result = await handle.wait();
      return this.executeResponse(result.stdout ?? '', result.stderr ?? '', result.exitCode ?? 0);
    } catch (error) {
      if (this.signal?.aborted) throw this.signal.reason;
      if (!(error instanceof CommandExitError)) throw error;
      return this.executeResponse(error.stdout ?? '', error.stderr ?? '', error.exitCode ?? 1);
    } finally {
      this.signal?.removeEventListener('abort', abort);
    }
  }

  private executeResponse(stdout: string, stderr: string, exitCode: number): ExecuteResponse {
    const combined = stderr ? `${stdout}\n${stderr}` : stdout;
    if (Buffer.byteLength(combined, 'utf8') <= MAX_OUTPUT_BYTES) {
      return { output: combined, exitCode, truncated: false };
    }
    return {
      output: Buffer.from(combined, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8'),
      exitCode,
      truncated: true,
    };
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = [];
    for (const [filePath, content] of files) {
      try {
        const buffer = new ArrayBuffer(content.byteLength);
        new Uint8Array(buffer).set(content);
        await this.sandbox.files.write(filePath, buffer);
        results.push({ path: filePath, error: null });
      } catch (error) {
        results.push({
          path: filePath,
          error: classifyFileError(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];
    for (const filePath of paths) {
      try {
        const content = await this.sandbox.files.read(filePath, { format: 'bytes' });
        results.push({ path: filePath, content, error: null });
      } catch (error) {
        results.push({
          path: filePath,
          content: null,
          error: classifyFileError(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return results;
  }

  async pause(): Promise<void> {
    if (!this.running) return;
    await this.sandbox.pause({ keepMemory: false });
    this.running = false;
  }

  async kill(): Promise<void> {
    if (!this.running) return;
    try {
      await this.sandbox.kill();
    } finally {
      this.running = false;
    }
  }
}
