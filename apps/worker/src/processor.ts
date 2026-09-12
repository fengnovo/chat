import { fileURLToPath } from 'node:url';

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  createDeepAgentRuntime,
  DemoAgentDriver,
  type AgentDriver,
  type HeadlessAgentRuntime,
} from '@repo/agent-core';
import type { S3ArtifactStore } from '@repo/artifacts';
import {
  agentEventSchema,
  runEventsChannel,
  runJobSchema,
  type AgentEvent,
  type RunJob,
} from '@repo/contracts';
import type { AgentRepository } from '@repo/db';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { WorkerConfig } from './config.js';
import { withSessionLock } from './lock.js';
import { RedisCircuitBreakerStore } from './redis-circuit-breaker.js';
import { prepareWorkspace } from './workspace.js';

interface ProcessorServices {
  config: WorkerConfig;
  repository: AgentRepository;
  redis: Redis;
  publisher: Redis;
  checkpointer: PostgresSaver;
  artifacts: S3ArtifactStore;
  controllers: Map<string, AbortController>;
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

async function createRuntime(
  services: ProcessorServices,
  job: RunJob,
  signal: AbortSignal,
): Promise<HeadlessAgentRuntime> {
  const options = {
    runId: job.runId,
    sessionId: job.sessionId,
    workspacePath: job.workspacePath,
    checkpointer: services.checkpointer,
    models: services.config.models,
    circuitBreaker: new RedisCircuitBreakerStore(
      services.redis,
      job.tenantId,
    ),
    autoApproveTools: job.approvalMode === 'session',
    signal,
  };
  if (services.config.AGENT_DRIVER === 'demo') {
    const driver: AgentDriver = new DemoAgentDriver();
    return driver.create(options);
  }
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  return createDeepAgentRuntime({
    ...options,
    mcpConfigPath:
      services.config.MCP_CONFIG_PATH ?? `${root}/packages/ai-cli/mcp/mcp.json`,
  });
}

export function createRunProcessor(services: ProcessorServices) {
  return async (bullJob: Job): Promise<void> => {
    const job = runJobSchema.parse(bullJob.data);
    if (bullJob.id) await services.repository.markDispatchConsumed(String(bullJob.id));
    await withSessionLock(services.redis, job.sessionId, async () => {
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
      let terminalEventWritten = false;
      try {
        job.workspacePath = await prepareWorkspace(
          services.config.WORKSPACE_ROOT,
          job.workspacePath,
          job.kind === 'start' ? job.workspaceSource : undefined,
          (objectKey) => services.artifacts.getObjectBytes(objectKey),
          controller.signal,
        );
        runtime = await createRuntime(services, job, controller.signal);
        const events =
          job.kind === 'start'
            ? runtime.run(job.message)
            : job.kind === 'resume-approval'
              ? runtime.resume({
                  kind: 'approval',
                  decision: job.decision.decision,
                  ...(job.decision.message ? { message: job.decision.message } : {}),
                })
              : runtime.resume({
                  kind: 'question',
                  answer: {
                    selections: job.answer.selections,
                    ...(job.answer.customText ? { customText: job.answer.customText } : {}),
                  },
                });
        for await (const event of events) {
          await persistEvent(services, job, event);
          terminalEventWritten = terminalStatus(event) !== null;
        }
      } catch (error) {
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
        await runtime?.dispose();
      }
    });
  };
}
