import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
import { prepareWorkspace, remoteWorkspacePath } from './workspace.js';

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

/**
 * 按配置创建本轮沙箱。
 * docker 模式下每次 run 复用同一宿主会话目录，因此不需要持久化沙箱 ID；
 * e2b-cloud 模式仍复用 E2B 的沙箱标识。
 */
async function acquireSandbox(
  services: ProcessorServices,
  job: RunJob,
  workspace: { workspaceId: string; sandboxId: string | null },
  signal: AbortSignal,
): Promise<SandboxInstance> {
  const config = services.config;
  if (config.SANDBOX_RUNTIME === 'docker') {
    return DockerSandboxBackend.create({
      sessionId: workspace.workspaceId,
      rootDirectory: config.DOCKER_SANDBOX_SESSIONS_ROOT,
      image: config.DOCKER_SANDBOX_IMAGE,
      commandTimeoutMs: config.DOCKER_SANDBOX_COMMAND_TIMEOUT_MS,
    });
  }

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
      return await E2BSandbox.connect(workspace.sandboxId, sandboxOptions);
    } catch {
      await services.repository
        .clearWorkspaceSandboxId(
          job.tenantId,
          workspace.workspaceId,
          workspace.sandboxId,
        )
        .catch(() => undefined);
    }
  }
  const sandbox = await E2BSandbox.create(sandboxOptions);
  const saved = await services.repository.saveWorkspaceSandboxId(
    job.tenantId,
    workspace.workspaceId,
    sandbox.id,
  );
  if (!saved) {
    await sandbox.kill().catch(() => undefined);
    throw new Error('Workspace sandbox identity changed concurrently');
  }
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
): Promise<HeadlessAgentRuntime> {
  if (!backend) throw new Error('Deep agent requires a sandbox backend');
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const knowledgeMcpEnabled = services.config.KNOWLEDGE_MCP_ENABLED &&
    Boolean(services.config.KNOWLEDGE_MCP_URL && services.config.KNOWLEDGE_MCP_SECRET) &&
    job.knowledgeBaseIds.length > 0;
  const knowledgeToken = knowledgeMcpEnabled
    ? await createKnowledgeRunToken(job, services.config.KNOWLEDGE_MCP_SECRET!)
    : '';
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
    mcpConfigPath:
      services.config.MCP_CONFIG_PATH ?? `${root}/packages/ai-cli/mcp/mcp.json`,
    knowledgeMcp: {
      url: services.config.KNOWLEDGE_MCP_URL ?? '',
      token: knowledgeToken,
      timeoutMs: services.config.KNOWLEDGE_MCP_TIMEOUT_MS,
      enabled: knowledgeMcpEnabled,
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

/**
 * 取消或失败时清理沙箱。
 * docker 模式删除宿主会话目录；e2b-cloud 模式 kill 远程沙箱并清除持久化标识。
 */
async function killPersistedSandbox(services: ProcessorServices, job: RunJob): Promise<void> {
  if (services.config.SANDBOX_RUNTIME === 'docker') {
    const workspace = await services.repository
      .getWorkspaceSandboxForWorker(job.tenantId, job.sessionId)
      .catch(() => null);
    if (!workspace) return;
    const sandbox = await DockerSandboxBackend.create({
      sessionId: workspace.workspaceId,
      rootDirectory: services.config.DOCKER_SANDBOX_SESSIONS_ROOT,
      image: services.config.DOCKER_SANDBOX_IMAGE,
      commandTimeoutMs: services.config.DOCKER_SANDBOX_COMMAND_TIMEOUT_MS,
    }).catch(() => null);
    await sandbox?.destroy().catch(() => undefined);
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
        await observed('workspace.prepare', () =>
          prepareWorkspace(
            acquiredSandbox,
            remotePath,
            job.kind === 'start' ? job.workspaceSource : undefined,
            (objectKey) => services.artifacts.getObjectBytes(objectKey),
            job.kind === 'start',
          ),
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
        runtime = await createRuntime(
          services,
          job,
          remotePath,
          acquiredSandbox,
          controller.signal,
          agentTelemetry,
          langchainCallbacks,
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
                  job.message,
                  job.attachments.map((attachment) => ({
                    mediaType: attachment.mediaType,
                    dataUrl: attachment.dataUrl,
                    ...(attachment.filename ? { filename: attachment.filename } : {}),
                  })),
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
            if (sandbox instanceof DockerSandboxBackend) {
              // 容器本身是 --rm 短生命周期，无需 kill/pause；
              // 仅在取消或失败时删除宿主会话目录。
              if (shouldKill) {
                await sandbox.destroy().catch(() => undefined);
              } else {
                await sandbox.close().catch(() => undefined);
              }
            } else if (shouldKill) {
              await sandbox.kill().catch(() => undefined);
              if (workspaceId) {
                await services.repository.clearWorkspaceSandboxId(
                  job.tenantId,
                  workspaceId,
                  sandbox.id,
                ).catch(() => undefined);
              }
            } else {
              await sandbox.pause().catch(() => undefined);
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
