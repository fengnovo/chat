import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, interrupt, type Interrupt } from '@langchain/langgraph';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { AgentEvent } from '@repo/contracts';
import { LangSmithSandbox, LocalShellBackend, createDeepAgent } from 'deepagents';
import { humanInTheLoopMiddleware, modelCallLimitMiddleware, todoListMiddleware } from 'langchain';
import type { HITLRequest, HITLResponse } from 'langchain';
import { z } from 'zod';

import { createResilientModelRouter } from './model-router.js';
import type {
  AgentResumeInput,
  HeadlessAgentOptions,
  HeadlessAgentRuntime,
  ModelRouterEvent,
} from './types.js';

interface UserQuestionRequest {
  kind: 'ask_user';
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple: boolean;
  allowCustom: boolean;
}

type AgentInterruptRequest = HITLRequest | UserQuestionRequest;
type AgentStreamEvent =
  | ['values', Record<string, unknown>]
  | ['messages', [unknown, Record<string, unknown>]]
  | ['tools', Record<string, unknown>];

function timestamp() {
  return new Date().toISOString();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && 'text' in block
        ? String((block as { text: unknown }).text)
        : '',
    )
    .join('');
}

export function assistantTextOf(message: unknown): string {
  if (!AIMessage.isInstance(message)) return '';
  return textOf(message.content);
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (name === 'execute') return `$ ${String(args.command ?? '?')}`;
  if (name === 'write_file' || name === 'edit_file') {
    const filePath = String(args.file_path ?? args.path ?? '?');
    return `${filePath}（${String(args.content ?? '').length} 字符）`;
  }
  if (name === 'delete') return String(args.file_path ?? args.path ?? JSON.stringify(args));
  const raw = JSON.stringify(args);
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

function isQuestion(value: AgentInterruptRequest): value is UserQuestionRequest {
  return 'kind' in value && value.kind === 'ask_user';
}

function createAskUserTool() {
  return tool(
    ({ question, options, multiple, allowCustom }) => {
      const answer = interrupt<UserQuestionRequest, { selections: unknown[]; customText?: string }>({
        kind: 'ask_user',
        question,
        options: options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        multiple,
        allowCustom,
      });
      return JSON.stringify(answer);
    },
    {
      name: 'ask_user',
      description: '需求存在会显著改变结果的歧义时，向用户提出一个结构化问题。',
      schema: z.object({
        question: z.string().min(1),
        options: z
          .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
          .min(2)
          .max(9),
        multiple: z.boolean().default(false),
        allowCustom: z.boolean().default(false),
      }),
    },
  );
}

async function createBackend(workspacePath: string, inheritEnv: boolean) {
  if (process.env.CODE_AGENT_BACKEND === 'sandbox') {
    const backend = await LangSmithSandbox.create({});
    return { backend, mode: 'sandbox' as const };
  }
  const backend = new LocalShellBackend({
    rootDir: workspacePath,
    virtualMode: false,
    timeout: 180,
    maxOutputBytes: 200_000,
    inheritEnv,
  });
  await backend.initialize();
  return { backend, mode: 'local' as const };
}

async function loadMcpTools(configPath?: string) {
  if (!configPath || !existsSync(configPath)) {
    return { tools: [], status: 'not configured', client: null };
  }
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const client = new MultiServerMCPClient(config as never);
  const tools = await client.getTools();
  return { tools, status: `${tools.length} tools connected`, client };
}

function routerEvent(runId: string, event: ModelRouterEvent): AgentEvent | null {
  if (event.type === 'model.retry' && event.model && event.attempt && event.delayMs !== undefined) {
    return {
      runId,
      timestamp: timestamp(),
      type: 'model.retry',
      model: event.model,
      attempt: event.attempt,
      delayMs: event.delayMs,
      reason: event.reason,
    };
  }
  if (event.type === 'model.fallback' && event.from && event.to) {
    return {
      runId,
      timestamp: timestamp(),
      type: 'model.fallback',
      from: event.from,
      to: event.to,
      reason: event.reason,
    };
  }
  return null;
}

export async function createDeepAgentRuntime(
  options: HeadlessAgentOptions,
): Promise<HeadlessAgentRuntime> {
  const pendingRouterEvents: AgentEvent[] = [];
  const router = await createResilientModelRouter({
    models: options.models,
    ...(options.circuitBreaker ? { circuitBreaker: options.circuitBreaker } : {}),
    onEvent: (event) => {
      const normalized = routerEvent(options.runId, event);
      if (normalized) pendingRouterEvents.push(normalized);
    },
  });
  const backendHandle = await createBackend(options.workspacePath, options.inheritEnv ?? false);
  const mcp = await loadMcpTools(options.mcpConfigPath);
  const mcpApprovalRules = Object.fromEntries(
    mcp.tools
      .map((mcpTool) => String((mcpTool as { name?: unknown }).name ?? ''))
      .filter((name) => name && name !== 'ask_user')
      .map((name) => [name, { allowedDecisions: ['approve', 'reject'] }]),
  );
  const agent = createDeepAgent({
    model: router.primary,
    checkpointer: options.checkpointer as never,
    backend: backendHandle.backend as never,
    tools: [createAskUserTool(), ...mcp.tools] as never,
    skills: options.skills ?? [],
    memory: options.memory ?? [],
    systemPrompt: [
      `你是运行在隔离工作区中的 coding agent，工作目录是：${options.workspacePath}`,
      '只有任务需要理解或修改项目时才检查项目结构；寒暄和通用问答直接回答。多步任务使用 todo；修改完成后运行相关测试或类型检查。',
      '文件写入、删除和命令执行必须经过人工审批。不要读取工作区之外的路径。',
      '遇到会显著改变结果且无法从上下文判断的问题时使用 ask_user。',
    ].join('\n'),
    middleware: [
      router.middleware as never,
      todoListMiddleware() as never,
      modelCallLimitMiddleware({
        runLimit: 60,
        threadLimit: 300,
        exitBehavior: 'end',
      } as never) as never,
      humanInTheLoopMiddleware({
        interruptOn: {
          write_file: { allowedDecisions: ['approve', 'reject'] },
          edit_file: { allowedDecisions: ['approve', 'reject'] },
          delete: { allowedDecisions: ['approve', 'reject'] },
          ...mcpApprovalRules,
          execute: { allowedDecisions: ['approve', 'reject'] },
        },
      } as never) as never,
    ] as never,
  });
  const runnable = agent as unknown as {
    stream(input: unknown, config: unknown): Promise<AsyncIterable<AgentStreamEvent>>;
    getState(config: unknown): Promise<unknown>;
  };
  const config = {
    configurable: { thread_id: options.sessionId },
    recursionLimit: 80,
    runName: 'web-coding-agent',
    tags: ['coding-agent', backendHandle.mode],
    metadata: {
      run_id: options.runId,
      thread_id: options.sessionId,
      backend: backendHandle.mode,
      cwd: options.workspacePath,
    },
    streamMode: ['values', 'messages', 'tools'] as Array<'values' | 'messages' | 'tools'>,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  async function* execute(input: unknown): AsyncIterable<AgentEvent> {
    let interruptRequest: AgentInterruptRequest | null = null;
    let interruptId: string = randomUUID();
    let lastTodos = '';
    try {
      const stream = await runnable.stream(input, config);
      for await (const [mode, payload] of stream) {
        while (pendingRouterEvents.length > 0) {
          const event = pendingRouterEvents.shift();
          if (event) yield event;
        }
        if (mode === 'messages') {
          const text = assistantTextOf(payload[0]);
          if (text) {
            yield { runId: options.runId, timestamp: timestamp(), type: 'assistant.delta', text };
          }
          continue;
        }
        if (mode === 'tools') {
          const eventName = String(payload.event ?? '');
          const toolName = String(payload.name ?? 'tool');
          const invocationId = String(payload.run_id ?? payload.runId ?? randomUUID());
          const data = (payload.data ?? {}) as Record<string, unknown>;
          if (eventName === 'on_tool_start') {
            yield {
              runId: options.runId,
              timestamp: timestamp(),
              type: 'tool.started',
              invocationId,
              tool: toolName,
              input: data.input ?? null,
            };
          } else if (eventName === 'on_tool_end') {
            yield {
              runId: options.runId,
              timestamp: timestamp(),
              type: 'tool.completed',
              invocationId,
              tool: toolName,
              output: data.output ?? null,
            };
          }
          continue;
        }

        if (Array.isArray(payload.todos)) {
          const serialized = JSON.stringify(payload.todos);
          if (serialized !== lastTodos) {
            lastTodos = serialized;
            yield {
              runId: options.runId,
              timestamp: timestamp(),
              type: 'todo.updated',
              todos: payload.todos as Array<{
                content: string;
                status: 'pending' | 'in_progress' | 'completed';
              }>,
            };
          }
        }
        const interrupts = (payload as { __interrupt__?: Array<Interrupt<AgentInterruptRequest>> })
          .__interrupt__;
        const firstInterrupt = interrupts?.[0];
        if (firstInterrupt?.value) {
          interruptRequest = firstInterrupt.value;
          interruptId = firstInterrupt.id ?? interruptId;
        }
      }

      while (pendingRouterEvents.length > 0) {
        const event = pendingRouterEvents.shift();
        if (event) yield event;
      }
      if (!interruptRequest) {
        const state = (await runnable.getState(config)) as {
          tasks?: Array<{ interrupts?: Array<{ id?: string; value: AgentInterruptRequest }> }>;
        };
        const paused = state.tasks?.find((task) => (task.interrupts?.length ?? 0) > 0);
        const firstInterrupt = paused?.interrupts?.[0];
        if (firstInterrupt) {
          interruptRequest = firstInterrupt.value;
          interruptId = firstInterrupt.id ?? interruptId;
        }
      }

      if (interruptRequest) {
        if (isQuestion(interruptRequest)) {
          yield {
            runId: options.runId,
            timestamp: timestamp(),
            type: 'question.required',
            interruptId,
            question: {
              question: interruptRequest.question,
              options: interruptRequest.options.map((option) => ({
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
              })),
              multiple: interruptRequest.multiple,
              allowCustom: interruptRequest.allowCustom,
            },
          };
        } else {
          yield {
            runId: options.runId,
            timestamp: timestamp(),
            type: 'approval.required',
            interruptId,
            actions: interruptRequest.actionRequests.map((request) => ({
              name: request.name,
              args: (request.args ?? {}) as Record<string, unknown>,
              summary: summarizeArgs(request.name, (request.args ?? {}) as Record<string, unknown>),
            })),
          };
        }
        return;
      }
      yield { runId: options.runId, timestamp: timestamp(), type: 'run.completed' };
    } catch (error) {
      if (options.signal?.aborted) {
        yield { runId: options.runId, timestamp: timestamp(), type: 'run.cancelled' };
        return;
      }
      yield {
        runId: options.runId,
        timestamp: timestamp(),
        type: 'run.failed',
        code: 'AGENT_RUN_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function* runInitial(message: string): AsyncIterable<AgentEvent> {
    yield { runId: options.runId, timestamp: timestamp(), type: 'run.started' };
    yield* execute({ messages: [new HumanMessage(message)], todos: [] });
  }

  async function* resumeApproval(
    input: Extract<AgentResumeInput, { kind: 'approval' }>,
  ): AsyncIterable<AgentEvent> {
    const state = (await runnable.getState(config)) as {
      tasks?: Array<{ interrupts?: Array<{ value?: AgentInterruptRequest }> }>;
    };
    const request = state.tasks
      ?.flatMap((task) => task.interrupts ?? [])
      .map((item) => item.value)
      .find((value): value is HITLRequest => Boolean(value && !isQuestion(value)));
    const decisionCount = Math.max(1, request?.actionRequests.length ?? 1);
    const response: HITLResponse = {
      decisions: Array.from({ length: decisionCount }, () =>
        input.decision === 'approve'
          ? ({ type: 'approve' } as const)
          : ({
              type: 'reject' as const,
              message: input.message ?? '用户拒绝了该操作。请放弃或采用其他方案。',
            } as const),
      ),
    };
    yield* execute(
      new Command({
        resume: response,
        ...(input.decision === 'reject' ? { update: { todos: [] } } : {}),
      }),
    );
  }

  return {
    backendMode: backendHandle.mode,
    mcpStatus: mcp.status,
    run(message: string) {
      return runInitial(message);
    },
    resume(input: AgentResumeInput) {
      if (input.kind === 'question') {
        return execute(new Command({ resume: input.answer }));
      }
      return resumeApproval(input);
    },
    async dispose() {
      await mcp.client?.close();
    },
  };
}

export { AIMessage, ToolMessage };
