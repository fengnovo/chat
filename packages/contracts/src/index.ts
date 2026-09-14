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

export const knowledgeBaseIdsSchema = z
  .array(z.uuid())
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'knowledge base ids must be unique',
  });

export const citationSchema = z.object({
  chunkId: z.uuid(),
  documentId: z.uuid(),
  documentName: z.string().trim().min(1).max(255),
  ordinal: z.number().int().nonnegative(),
  heading: z.string().trim().max(500).optional(),
  score: z.number().finite().min(-1).max(1),
  via: z.enum(['vector', 'graph', 'both']),
});

export const relationCitationSchema = z.object({
  source: z.string().trim().min(1).max(255),
  relation: z.string().trim().min(1).max(255),
  target: z.string().trim().min(1).max(255),
  chunkIds: z.array(z.uuid()).max(10),
});

export const retrievalStatsSchema = z.object({
  vectorHits: z.number().int().nonnegative().max(10_000),
  graphHops: z.number().int().nonnegative().max(100),
  searchedKbs: z.number().int().nonnegative().max(10),
  durationMs: z.number().int().nonnegative().max(300_000),
  truncated: z.boolean(),
});

export const knowledgeRunTokenClaimsSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  sessionId: z.uuid(),
  runId: z.uuid(),
  kbIds: knowledgeBaseIdsSchema,
  jti: z.uuid(),
  exp: z.number().int().positive(),
  aud: z.literal('knowledge-service'),
});

export type KnowledgeRunTokenClaims = z.infer<
  typeof knowledgeRunTokenClaimsSchema
>;

const eventBase = {
  runId: z.uuid(),
  timestamp: z.string().datetime(),
};

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('run.started') }),
  z.object({ ...eventBase, type: z.literal('assistant.delta'), text: z.string() }),
  /**
   * 模型在「带工具调用的轮次」里输出的过程旁白。
   * 这类文本属于执行过程而非最终答复，前端只在可折叠的过程区展示，
   * 不能混进最终消息正文。
   */
  z.object({ ...eventBase, type: z.literal('assistant.narration'), text: z.string() }),
  /** 单次模型调用的真实用量增量；前端按 run 累加即为本轮总消耗。 */
  z.object({
    ...eventBase,
    type: z.literal('usage.updated'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
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
  z.object({
    ...eventBase,
    type: z.literal('retrieval.completed'),
    retrievalId: z.uuid(),
    toolCallId: z.string().min(1).max(255),
    knowledgeBaseIds: knowledgeBaseIdsSchema,
    query: z.string().trim().min(1).max(10_000),
    citations: z.array(citationSchema).max(20),
    relations: z.array(relationCitationSchema).max(20),
    stats: retrievalStatsSchema,
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
  knowledgeBaseIds: knowledgeBaseIdsSchema.default([]),
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

/**
 * 聊天消息附带的图片（多模态视觉输入）。
 * 以 data URL 内联在 run 派发任务中，模型按 OpenAI 兼容 image_url 结构消费。
 */
export const runImageAttachmentSchema = z.object({
  kind: z.literal('image'),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  filename: z.string().trim().min(1).max(255).optional(),
  dataUrl: z.string().startsWith('data:').max(14_000_000),
});
export type RunImageAttachment = z.infer<typeof runImageAttachmentSchema>;

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
    knowledgeBaseIds: knowledgeBaseIdsSchema,
    attachments: z.array(runImageAttachmentSchema).max(5).default([]),
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
    knowledgeBaseIds: knowledgeBaseIdsSchema,
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
    knowledgeBaseIds: knowledgeBaseIdsSchema,
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
