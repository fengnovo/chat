import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  createDeepAgentRuntime,
  type AgentTelemetry,
  type ChatImageAttachment,
  DockerSandboxBackend,
  E2BSandbox,
  type HeadlessAgentRuntime,
} from '@repo/agent-core';
import type { S3ArtifactStore } from '@repo/artifacts';
import {
  agentEventSchema,
  RUN_QUEUE_NAME,
  runEventsChannel,
  runJobSchema,
  type AgentEvent,
  type RunAttachmentRef,
  type RunJob,
} from '@repo/contracts';
import { extractObservabilityContext, type JobKind } from '@repo/observability';
import type { AgentRepository } from '@repo/db';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { SignJWT } from 'jose';

import type { WorkerConfig } from './config.js';
import { createAgentTelemetry } from './agent-telemetry.js';
import { withSessionLock } from './lock.js';
import type { WorkerObservability } from './observability.js';
import type { WorkerLangfuse } from './langfuse.js';
import { RedisCircuitBreakerStore } from './redis-circuit-breaker.js';
import {
  prepareWorkspace,
  remoteWorkspacePath,
  safeRelativePath,
  uploadAgentResources,
  type AgentResources,
  type RemoteWorkspaceSandbox,
} from './workspace.js';

interface ProcessorServices {
  config: WorkerConfig;
  repository: AgentRepository;
  redis: Redis;
  publisher: Redis;
  checkpointer: PostgresSaver;
  artifacts: S3ArtifactStore;
  controllers: Map<string, AbortController>;
}

function metricJobKind(kind: RunJob['kind']): JobKind {
  return kind === 'start' ? 'run' : 'resume';
}

/** Web Worker 的通用 MCP 必须显式启用，不能回退到 CLI 的示例配置。 */
export function resolveWorkerMcpConfigPath(
  configuredPath: string | undefined,
): string | undefined {
  return configuredPath;
}

/** 遥测调用永不影响任务执行。 */
function safely<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}

function terminalStatus(event: AgentEvent) {
  if (event.type === 'run.completed') return 'completed' as const;
  if (event.type === 'run.cancelled') return 'cancelled' as const;
  if (event.type === 'run.failed') return 'failed' as const;
  if (event.type === 'approval.required') return 'waiting_approval' as const;
  if (event.type === 'question.required') return 'waiting_question' as const;
  return null;
}

async function persistEvent(
  services: ProcessorServices,
  job: RunJob,
  event: AgentEvent,
) {
  const validated = agentEventSchema.parse(event);
  const persisted = await services.repository.appendEvent(job.tenantId, validated);
  await services.publisher.publish(runEventsChannel(job.runId), String(persisted.seq));
  if (event.type === 'approval.required') {
    await services.repository.createInterrupt(job.tenantId, job.runId, {
      id: event.interruptId,
      kind: 'approval',
      request: event.actions,
    });
  } else if (event.type === 'question.required') {
    await services.repository.createInterrupt(job.tenantId, job.runId, {
      id: event.interruptId,
      kind: 'question',
      request: event.question,
    });
  }
  const status = terminalStatus(event);
  if (status) {
    await services.repository.updateRunStatus(
      job.tenantId,
      job.runId,
      status,
      event.type === 'run.failed' ? { code: event.code, message: event.message } : undefined,
    );
  }
}

type SandboxInstance = DockerSandboxBackend | E2BSandbox;

/** 进程级沙箱缓存：按 workspaceId 复用活跃连接，跳过重复的 E2B connect/create 网络往返。 */
const sandboxCache = new Map<
  string,
  { sandbox: SandboxInstance; lastUsedAt: number; timeoutMs: number }
>();

function sandboxCacheTTLMs(configTimeoutMs?: number): number {
  // 缓存有效期略短于沙箱自身超时，留出安全余量。
  return (configTimeoutMs ?? 600_000) * 0.8;
}

function getCachedSandbox(workspaceId: string, timeoutMs: number): SandboxInstance | null {
  const entry = sandboxCache.get(workspaceId);
  if (!entry) return null;
  const age = Date.now() - entry.lastUsedAt;
  if (age > sandboxCacheTTLMs(entry.timeoutMs)) {
    sandboxCache.delete(workspaceId);
    if (entry.sandbox instanceof E2BSandbox) {
      entry.sandbox.pause().catch(() => undefined);
    }
    return null;
  }
  return entry.sandbox;
}

function putCachedSandbox(workspaceId: string, sandbox: SandboxInstance, timeoutMs: number): void {
  sandboxCache.set(workspaceId, { sandbox, lastUsedAt: Date.now(), timeoutMs });
}

function evictCachedSandbox(workspaceId: string): SandboxInstance | null {
  const entry = sandboxCache.get(workspaceId);
  if (!entry) return null;
  sandboxCache.delete(workspaceId);
  return entry.sandbox;
}

/**
 * 按配置创建本轮沙箱。
 * docker 模式下每次 run 复用同一宿主会话目录，因此不需要持久化沙箱 ID；
 * e2b-cloud 仍复用 E2B 的沙箱标识，进程级缓存进一步跳过重复 connect。
 */
async function acquireSandbox(
  services: ProcessorServices,
  job: RunJob,
  workspace: { workspaceId: string; sandboxId: string | null },
  signal: AbortSignal,
): Promise<SandboxInstance> {
  const config = services.config;
  // 进程级缓存命中直接跳过 E2B connect/create 网络往返。
  const cached = getCachedSandbox(workspace.workspaceId, config.E2B_TIMEOUT_MS ?? 600_000);
  if (cached) {
    if (cached instanceof E2BSandbox && config.E2B_TIMEOUT_MS) {
      // 续租超时，确保长 run 不会在执行中过期。
      await cached.setTimeout(config.E2B_TIMEOUT_MS).catch(() => undefined);
    }
    return cached;
  }

  let sandbox: SandboxInstance;
  if (config.SANDBOX_RUNTIME === 'docker') {
    sandbox = await DockerSandboxBackend.create({
      sessionId: workspace.workspaceId,
      rootDirectory: config.DOCKER_SANDBOX_SESSIONS_ROOT,
      image: config.DOCKER_SANDBOX_IMAGE,
      commandTimeoutMs: config.DOCKER_SANDBOX_COMMAND_TIMEOUT_MS,
    });
  } else {
    const apiKey = config.E2B_API_KEY;
    if (!apiKey) throw new Error('E2B_API_KEY is required for e2b-cloud');
    const sandboxOptions = {
      apiKey,
      ...(config.E2B_API_URL ? { apiUrl: config.E2B_API_URL } : {}),
      ...(config.E2B_SANDBOX_URL ? { sandboxUrl: config.E2B_SANDBOX_URL } : {}),
      template: config.E2B_TEMPLATE,
      timeoutMs: config.E2B_TIMEOUT_MS,
      signal,
    };
    if (workspace.sandboxId) {
      try {
        sandbox = await E2BSandbox.connect(workspace.sandboxId, sandboxOptions);
      } catch {
        await services.repository
          .clearWorkspaceSandboxId(
            job.tenantId,
            workspace.workspaceId,
            workspace.sandboxId,
          )
          .catch(() => undefined);
        sandbox = await E2BSandbox.create(sandboxOptions);
        const saved = await services.repository.saveWorkspaceSandboxId(
          job.tenantId,
          workspace.workspaceId,
          sandbox.id,
        );
        if (!saved) {
          await sandbox.kill().catch(() => undefined);
          throw new Error('Workspace sandbox identity changed concurrently');
        }
      }
    } else {
      sandbox = await E2BSandbox.create(sandboxOptions);
      const saved = await services.repository.saveWorkspaceSandboxId(
        job.tenantId,
        workspace.workspaceId,
        sandbox.id,
      );
      if (!saved) {
        await sandbox.kill().catch(() => undefined);
        throw new Error('Workspace sandbox identity changed concurrently');
      }
    }
  }
  putCachedSandbox(workspace.workspaceId, sandbox, config.E2B_TIMEOUT_MS ?? 600_000);
  return sandbox;
}

async function createRuntime(
  services: ProcessorServices,
  job: RunJob,
  workspacePath: string,
  backend: SandboxInstance,
  signal: AbortSignal,
  agentTelemetry?: AgentTelemetry,
  callbacks?: readonly unknown[],
  agentResources?: AgentResources,
): Promise<HeadlessAgentRuntime> {
  if (!backend) throw new Error('Deep agent requires a sandbox backend');
  const knowledgeMcpEnabled = services.config.KNOWLEDGE_MCP_ENABLED &&
    Boolean(services.config.KNOWLEDGE_MCP_URL && services.config.KNOWLEDGE_MCP_SECRET) &&
    job.knowledgeBaseIds.length > 0;
  const knowledgeToken = knowledgeMcpEnabled
    ? await createKnowledgeRunToken(job, services.config.KNOWLEDGE_MCP_SECRET!)
    : '';
  const mcpConfigPath = resolveWorkerMcpConfigPath(services.config.MCP_CONFIG_PATH);
  return createDeepAgentRuntime({
    runId: job.runId,
    sessionId: job.sessionId,
    workspacePath,
    backend,
    backendMode: services.config.SANDBOX_RUNTIME === 'docker' ? 'docker' : 'e2b',
    checkpointer: services.checkpointer,
    models: services.config.models,
    circuitBreaker: new RedisCircuitBreakerStore(
      services.redis,
      job.tenantId,
      undefined,
      undefined,
      agentTelemetry,
    ),
    ...(agentTelemetry ? { telemetry: agentTelemetry } : {}),
    ...(callbacks && callbacks.length > 0 ? { callbacks } : {}),
    autoApproveTools: job.approvalMode === 'session',
    recursionLimit: services.config.AGENT_RECURSION_LIMIT,
    modelCallLimit: services.config.AGENT_MODEL_CALL_LIMIT,
    signal,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    knowledgeMcp: {
      url: services.config.KNOWLEDGE_MCP_URL ?? '',
      token: knowledgeToken,
      timeoutMs: services.config.KNOWLEDGE_MCP_TIMEOUT_MS,
      enabled: knowledgeMcpEnabled,
    },
    ...(agentResources?.memory && agentResources.memory.length > 0 ? { memory: agentResources.memory } : {}),
    ...(agentResources?.skills && agentResources.skills.length > 0 ? { skills: agentResources.skills } : {}),
    summarization: {
      triggerTokens: services.config.AGENT_SUMMARIZATION_TRIGGER_TOKENS,
      keepTokens: services.config.AGENT_SUMMARIZATION_KEEP_TOKENS,
      truncateArgsTokens: 40_000,
    },
  });
}

export async function createKnowledgeRunToken(job: RunJob, secret: string): Promise<string> {
  return new SignJWT({
    tenantId: job.tenantId,
    userId: job.userId,
    sessionId: job.sessionId,
    runId: job.runId,
    kbIds: job.knowledgeBaseIds,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setJti(randomUUID())
    .setAudience('knowledge-service')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

const IMAGE_ATTACHMENT_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/**
 * run 开始前按引用取回用户附件，按类型分流：
 * - image：转 data URL 交给视觉模型；
 * - text：UTF-8 解码后内联拼进用户消息（契约已限制 ≤200KB）；
 * - file：投进沙箱工作区根目录，Agent 可直接读写。
 * 对象存储只在 worker 内部访问，浏览器全程只拿鉴权重定向链接。
 */
async function prepareRunAttachments(
  services: ProcessorServices,
  sandbox: RemoteWorkspaceSandbox,
  remotePath: string,
  attachments: RunAttachmentRef[],
): Promise<{ appendedMessage: string; images: ChatImageAttachment[] }> {
  const images: ChatImageAttachment[] = [];
  let appendedMessage = '';
  const sandboxFiles: Array<[string, Uint8Array]> = [];
  const uploadedNames: string[] = [];

  for (const attachment of attachments) {
    const bytes = await services.artifacts.getObjectBytes(attachment.objectKey);
    if (attachment.kind === 'image') {
      if (!IMAGE_ATTACHMENT_MEDIA_TYPES.has(attachment.contentType)) {
        throw new Error(`Unsupported image attachment type: ${attachment.contentType}`);
      }
      images.push({
        mediaType: attachment.contentType as ChatImageAttachment['mediaType'],
        dataUrl: `data:${attachment.contentType};base64,${Buffer.from(bytes).toString('base64')}`,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    } else if (attachment.kind === 'text') {
      appendedMessage += `\n\n[附件 ${attachment.filename}]\n${new TextDecoder('utf-8').decode(bytes)}`;
    } else {
      // safeRelativePath 拒绝绝对路径与 .. 穿越；允许带子目录的文件名。
      const relativePath = safeRelativePath(attachment.filename);
      sandboxFiles.push([path.posix.join(remotePath, relativePath), bytes]);
      uploadedNames.push(relativePath);
    }
  }

  if (sandboxFiles.length > 0) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const directories = [...new Set(sandboxFiles.map(([target]) => path.posix.dirname(target)))];
    await sandbox.execute(`mkdir -p ${directories.map(quote).join(' ')}`);
    const results = await sandbox.uploadFiles(sandboxFiles);
    const failure = results.find((result) => result.error);
    if (failure) {
      throw new Error(`Failed to upload attachment ${failure.path}: ${failure.error}`);
    }
    appendedMessage += `\n\n以下附件已上传到工作区根目录：${uploadedNames
      .map((name) => `\`${name}\``)
      .join('、')}。请直接在工作区中读取使用。`;
  }

  return { appendedMessage, images };
}

/**
 * 取消或失败时清理沙箱。
 * e2b-cloud 模式 kill 远程沙箱并清除持久化标识；docker 模式无需处理：
 * 容器是每次 execute 的 --rm 短命容器、没有常驻进程，中止由 AbortController 负责，
 * 宿主工作区目录必须保留（删除后重建同名目录会让该会话后续 run 在 Docker Desktop 上
 * 永久挂载失败，且会丢掉用户上一轮文件）。
 */
async function killPersistedSandbox(services: ProcessorServices, job: RunJob): Promise<void> {
  if (services.config.SANDBOX_RUNTIME === 'docker') {
    return;
  }

  const workspace = await services.repository.getWorkspaceSandboxForWorker(
    job.tenantId,
    job.sessionId,
  ).catch(() => null);
  const apiKey = services.config.E2B_API_KEY;
  if (!workspace?.sandboxId || !apiKey) return;
  try {
    const sandbox = await E2BSandbox.connect(workspace.sandboxId, {
      apiKey,
      ...(services.config.E2B_API_URL
        ? { apiUrl: services.config.E2B_API_URL }
        : {}),
      ...(services.config.E2B_SANDBOX_URL
        ? { sandboxUrl: services.config.E2B_SANDBOX_URL }
        : {}),
      template: services.config.E2B_TEMPLATE,
      timeoutMs: services.config.E2B_TIMEOUT_MS,
    });
    await sandbox.kill();
  } catch {}
  await services.repository.clearWorkspaceSandboxId(
    job.tenantId,
    workspace.workspaceId,
    workspace.sandboxId,
  ).catch(() => undefined);
}

export function createRunProcessor(
  services: ProcessorServices,
  telemetry?: WorkerObservability,
  langfuse?: WorkerLangfuse,
) {
  return async (bullJob: Job): Promise<void> => {
    const job = runJobSchema.parse(bullJob.data);

    // 从 Outbox payload 恢复 producer 上下文。Consumer 是独立 root trace，
    // 用 span link 关联 outbox.dispatch，避免审批等待数小时形成超长父子 span。
    const producerContext = extractObservabilityContext(job.observability ?? {});
    const producerSpanContext = trace.getSpan(producerContext)?.spanContext();
    const links = producerSpanContext && trace.isSpanContextValid(producerSpanContext)
      ? [{
          context: producerSpanContext,
          attributes: { 'link.name': 'outbox.dispatch' },
        }]
      : [];
    const waitMs =
      typeof bullJob.timestamp === 'number' && typeof bullJob.processedOn === 'number'
        ? Math.max(0, bullJob.processedOn - bullJob.timestamp)
        : undefined;
    const startedAt = performance.now();
    const span = telemetry?.runtime.tracer.startSpan(
      'worker.job.execute',
      {
        kind: SpanKind.CONSUMER,
        links,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination.name': RUN_QUEUE_NAME,
          'messaging.operation.name': 'process',
          ...(bullJob.id ? { 'messaging.message.id': String(bullJob.id) } : {}),
          'job.kind': job.kind,
          run_id: job.runId,
          ...(waitMs !== undefined ? { 'queue.wait.ms': waitMs } : {}),
        },
      },
      ROOT_CONTEXT,
    );
    const activeContext = span
      ? trace.setSpan(ROOT_CONTEXT, span)
      : context.active();
    const jobKind = metricJobKind(job.kind);
    if (waitMs !== undefined && telemetry) {
      safely(() =>
        telemetry.metrics.queueWait({ queue: 'agent-runs', job: jobKind, waitMs }),
      );
    }

    let jobOutcome: 'completed' | 'failed' = 'completed';
    const agentTelemetry = telemetry ? createAgentTelemetry(telemetry) : undefined;
    const observed = async <T>(operation: string, action: () => Promise<T>): Promise<T> =>
      agentTelemetry
        ? agentTelemetry.runSpan({ runId: job.runId, operation }, action)
        : action();
    try {
      await context.with(activeContext, async () => {
        if (bullJob.id) await services.repository.markDispatchConsumed(String(bullJob.id));
        await withSessionLock(
          services.redis,
          job.sessionId,
          async () => {
      const record = await services.repository.getRunForWorker(job.tenantId, job.runId);
      if (!record) throw new Error('Run no longer exists');
      if (['completed', 'failed', 'cancelled'].includes(record.status)) return;
      if (record.cancelRequestedAt) {
        const cancelled: AgentEvent = {
          runId: job.runId,
          timestamp: new Date().toISOString(),
          type: 'run.cancelled',
        };
        await persistEvent(services, job, cancelled);
        await killPersistedSandbox(services, job);
        return;
      }

      const claimed = await services.repository.tryMarkRunRunning(
        job.tenantId,
        job.runId,
      );
      if (!claimed) return;
      const controller = new AbortController();
      services.controllers.set(job.runId, controller);
      let runtime: HeadlessAgentRuntime | null = null;
      let sandbox: SandboxInstance | null = null;
      let workspaceId: string | null = null;
      let terminalEventWritten = false;
      let shouldKill = false;
      try {
        const workspace = await services.repository.getWorkspaceSandboxForWorker(
          job.tenantId,
          job.sessionId,
        );
        if (!workspace) throw new Error('Workspace no longer exists');
        workspaceId = workspace.workspaceId;
        const acquiredSandbox = await observed('sandbox.acquire', () =>
          acquireSandbox(services, job, workspace, controller.signal),
        );
        sandbox = acquiredSandbox;
        const remotePath = services.config.SANDBOX_RUNTIME === 'docker'
          ? remoteWorkspacePath(services.config.DOCKER_SANDBOX_WORKSPACE_PATH)
          : remoteWorkspacePath(services.config.E2B_WORKSPACE_PATH);
        // 三个独立准备步骤并行执行——都只依赖 sandbox/remotePath，互不阻塞。
        const [, preparedAttachments, agentResources] = await observed(
          'preparation.parallel',
          () =>
            Promise.all([
              observed('workspace.prepare', () =>
                prepareWorkspace(
                  acquiredSandbox,
                  remotePath,
                  job.kind === 'start' ? job.workspaceSource : undefined,
                  (objectKey) => services.artifacts.getObjectBytes(objectKey),
                  job.kind === 'start',
                ),
              ),
              // 用户附件按引用取回：图片→视觉输入，文本→内联正文，二进制→工作区文件。
              job.kind === 'start' && job.attachments.length > 0
                ? observed('attachments.prepare', () =>
                    prepareRunAttachments(
                      services,
                      acquiredSandbox,
                      remotePath,
                      job.attachments,
                    ),
                  )
                : Promise.resolve({ appendedMessage: '', images: [] as ChatImageAttachment[] }),
              // 上传 DeepAgents memory/skills 到沙箱（宿主机路径由环境变量配置）。
              observed('agent.resources.upload', () =>
                uploadAgentResources(
                  acquiredSandbox,
                  remotePath,
                  services.config.AGENT_MEMORY_FILE,
                  services.config.AGENT_SKILLS_DIR,
                ),
              ),
            ]),
        );
        // Langfuse 按 run 采样：命中则在当前 job span 上下文内建一个 LangChain
        // callback（trace 上会带 tempo_trace_id）；任何异常退化为不写 Langfuse。
        const langchainCallbacks = langfuse
          ? safely(() =>
              langfuse.runCallbacks({
                runId: job.runId,
                sessionId: job.sessionId,
                userId: job.userId,
                runKind: job.kind,
              }),
            ) ?? undefined
          : undefined;
        runtime = await observed('agent.runtime.create', () =>
          createRuntime(
            services,
            job,
            remotePath,
            acquiredSandbox,
            controller.signal,
            agentTelemetry,
            langchainCallbacks,
            agentResources,
          ),
        );
        if (telemetry) {
          safely(() =>
            telemetry.logger.info(
              { run_id: job.runId, operation: 'worker.job.execute', reason: runtime!.mcpStatus },
              'run processing started',
            ),
          );
        } else {
          console.log(
            `[processor] run=${job.runId} kbIds=${JSON.stringify(job.knowledgeBaseIds)} mcp=${runtime.mcpStatus}`,
          );
        }
        await observed('agent.execute', async () => {
          const events =
            job.kind === 'start'
              ? runtime!.run(
                  `${job.message}${preparedAttachments.appendedMessage}`,
                  preparedAttachments.images,
                )
              : job.kind === 'resume-approval'
                ? runtime!.resume({
                    kind: 'approval',
                    decision: job.decision.decision,
                    ...(job.decision.message ? { message: job.decision.message } : {}),
                  })
                : runtime!.resume({
                    kind: 'question',
                    answer: {
                      selections: job.answer.selections,
                      ...(job.answer.customText ? { customText: job.answer.customText } : {}),
                    },
                  });
          for await (const event of events) {
            let persistOutcome: 'success' | 'failure' = 'success';
            const persistStartedAt = Date.now();
            try {
              await persistEvent(services, job, event);
            } catch (persistError) {
              persistOutcome = 'failure';
              throw persistError;
            } finally {
              safely(() =>
                agentTelemetry?.phase({
                  operation: 'persist',
                  outcome: persistOutcome,
                  durationMs: Date.now() - persistStartedAt,
                }),
              );
            }
            terminalEventWritten = terminalStatus(event) !== null;
            if (event.type === 'run.cancelled') shouldKill = true;
            // 步数耗尽时工作区是完整的，保留它用户才能接着上一轮继续；
            // 只有真正的执行失败才回收沙箱。
            if (event.type === 'run.failed' && event.code !== 'AGENT_STEP_LIMIT') {
              shouldKill = true;
            }
          }
        });
      } catch (error) {
        shouldKill = controller.signal.aborted || !terminalEventWritten;
        if (!terminalEventWritten) {
          const latest = await services.repository.getRunForWorker(
            job.tenantId,
            job.runId,
          );
          const cancelled = controller.signal.aborted || Boolean(latest?.cancelRequestedAt);
          await persistEvent(
            services,
            job,
            cancelled
              ? {
                  runId: job.runId,
                  timestamp: new Date().toISOString(),
                  type: 'run.cancelled',
                }
              : {
                  runId: job.runId,
                  timestamp: new Date().toISOString(),
                  type: 'run.failed',
                  code: 'WORKER_EXECUTION_FAILED',
                  message: error instanceof Error ? error.message : String(error),
                },
          );
        }
        if (!controller.signal.aborted) throw error;
      } finally {
        services.controllers.delete(job.runId);
        await runtime?.dispose().catch(() => undefined);
        await observed('cleanup', async () => {
          if (sandbox) {
            if (shouldKill) {
              // 强制销毁：从缓存移除后 kill/destroy + 清 DB 记录。
              if (workspaceId) evictCachedSandbox(workspaceId);
              if (sandbox instanceof E2BSandbox) {
                await sandbox.kill().catch(() => undefined);
                if (workspaceId) {
                  await services.repository.clearWorkspaceSandboxId(
                    job.tenantId,
                    workspaceId,
                    sandbox.id,
                  ).catch(() => undefined);
                }
              } else if (sandbox instanceof DockerSandboxBackend) {
                // 只释放句柄，绝不 rm -rf 宿主工作区：
                // 1) 续跑要复用同一工作区目录，上一轮写出的文件必须保留；
                // 2) Docker Desktop(macOS) 上，删除被 bind 过的宿主目录后再重建同名路径，
                //    VM 共享层会永久判定该路径不存在，导致该会话后续所有 run 都无法挂载。
                await sandbox.close().catch(() => undefined);
              }
            } else if (workspaceId) {
              // 正常结束放回进程级缓存，跳过下次 run 的 E2B connect 网络往返。
              putCachedSandbox(
                workspaceId,
                sandbox,
                services.config.E2B_TIMEOUT_MS ?? 600_000,
              );
            } else {
              // 没有 workspaceId 兜底时保守 pause，让 E2B 自己管理生命周期。
              if (sandbox instanceof E2BSandbox) {
                await sandbox.pause().catch(() => undefined);
              }
            }
          }
        });
      }
          },
          (outcome, durationMs) =>
            safely(() =>
              agentTelemetry?.phase({
                operation: 'session.lock.acquire',
                outcome,
                durationMs,
              }),
            ),
        );
      });
    } catch (error) {
      jobOutcome = 'failed';
      safely(() => {
        telemetry?.metrics.queueJob({
          queue: 'agent-runs',
          job: jobKind,
          outcome: 'failed',
          durationMs: performance.now() - startedAt,
        });
        span?.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) span?.recordException(error);
      });
      throw error;
    } finally {
      safely(() => {
        if (jobOutcome === 'completed') {
          telemetry?.metrics.queueJob({
            queue: 'agent-runs',
            job: jobKind,
            outcome: 'completed',
            durationMs: performance.now() - startedAt,
          });
        }
        span?.end();
      });
    }
  };
}
