import { z } from 'zod';

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'waiting_question',
  'completed',
  'failed',
  'cancelled',
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const todoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export const approvalActionSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  summary: z.string(),
});

export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const userQuestionSchema = z.object({
  question: z.string(),
  options: z.array(questionOptionSchema).min(2).max(9),
  multiple: z.boolean(),
  allowCustom: z.boolean(),
});

const eventBase = {
  runId: z.uuid(),
  timestamp: z.string().datetime(),
};

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('run.started') }),
  z.object({ ...eventBase, type: z.literal('assistant.delta'), text: z.string() }),
  z.object({
    ...eventBase,
    type: z.literal('model.retry'),
    model: z.string(),
    attempt: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('model.fallback'),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('tool.started'),
    invocationId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('tool.completed'),
    invocationId: z.string(),
    tool: z.string(),
    output: z.unknown(),
  }),
  z.object({ ...eventBase, type: z.literal('todo.updated'), todos: z.array(todoSchema) }),
  z.object({
    ...eventBase,
    type: z.literal('approval.required'),
    interruptId: z.string(),
    actions: z.array(approvalActionSchema).min(1),
  }),
  z.object({
    ...eventBase,
    type: z.literal('question.required'),
    interruptId: z.string(),
    question: userQuestionSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('artifact.created'),
    artifactId: z.uuid(),
    name: z.string(),
    contentType: z.string(),
  }),
  z.object({ ...eventBase, type: z.literal('run.completed') }),
  z.object({ ...eventBase, type: z.literal('run.cancelled') }),
  z.object({
    ...eventBase,
    type: z.literal('run.failed'),
    code: z.string(),
    message: z.string(),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

export const persistedAgentEventSchema = agentEventSchema.and(
  z.object({
    seq: z.number().int().positive(),
  }),
);

export type PersistedAgentEvent = z.infer<typeof persistedAgentEventSchema>;

export const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).default('新会话'),
  projectId: z.uuid().optional(),
  externalKey: z.string().trim().min(1).max(200).optional(),
});

export const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export const gitProjectSourceSchema = z.object({
  type: z.literal('git'),
  url: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:', {
      message: 'Only HTTPS Git repositories are supported',
    })
    .refine((value) => {
      const url = new URL(value);
      return !url.username && !url.password;
    }, 'Credentials must not be embedded in the Git URL'),
  ref: z.string().trim().min(1).max(200).optional(),
});

export const workspaceSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('empty') }),
  gitProjectSourceSchema,
  z.object({
    type: z.literal('upload'),
    objectKey: z.string().min(1).max(1_000),
  }),
]);

export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('empty') }),
    gitProjectSourceSchema,
  ]),
});

export const uploadProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(1_000),
        contentBase64: z.string().min(1),
      }),
    )
    .min(1)
    .max(1_000),
});

export const createRunSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  scope: z.enum(['once', 'session']).default('once'),
  message: z.string().trim().max(2_000).optional(),
});

export const questionAnswerSchema = z.object({
  selections: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      label: z.string(),
    }),
  ),
  customText: z.string().trim().max(4_000).optional(),
});

export const createArtifactUploadSchema = z.object({
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const runJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('start'),
    tenantId: z.uuid(),
    userId: z.uuid(),
    sessionId: z.uuid(),
    runId: z.uuid(),
    message: z.string(),
    workspacePath: z.string(),
    workspaceSource: workspaceSourceSchema.optional(),
    approvalMode: z.enum(['manual', 'session']).optional(),
  }),
  z.object({
    kind: z.literal('resume-approval'),
    tenantId: z.uuid(),
    userId: z.uuid(),
    sessionId: z.uuid(),
    runId: z.uuid(),
    workspacePath: z.string(),
    decision: approvalDecisionSchema,
    approvalMode: z.enum(['manual', 'session']).optional(),
  }),
  z.object({
    kind: z.literal('resume-question'),
    tenantId: z.uuid(),
    userId: z.uuid(),
    sessionId: z.uuid(),
    runId: z.uuid(),
    workspacePath: z.string(),
    answer: questionAnswerSchema,
    approvalMode: z.enum(['manual', 'session']).optional(),
  }),
]);

export type RunJob = z.infer<typeof runJobSchema>;

export interface AuthContext {
  userId: string;
  tenantId: string;
  roles: string[];
}

export const RUN_QUEUE_NAME = 'agent-runs';
export const runEventsChannel = (runId: string) => `agent:run:${runId}:events`;
export const runCancellationChannel = (runId: string) => `agent:run:${runId}:cancel`;
