# Knowledge GraphRAG MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在不改变现有 Agent、沙箱、checkpoint 和 outbox 语义的前提下，为本项目增加 Markdown/TXT 知识库的异步索引、GraphRAG 检索和可持久化引用闭环。

**Architecture:** 新增 @repo/knowledge-graphrag 纯算法/存储包和 apps/knowledge-service 单进程。API 负责资源鉴权、上传和 run 快照；Worker 通过独立 MCP HTTP client 调用检索，知识服务负责 BullMQ 索引消费和 MCP 检索。Postgres 是权威元数据/图谱来源，Qdrant 只保存可重建向量。

**Tech Stack:** TypeScript ESM、pnpm workspace、Node test runner、Zod、Drizzle schema、Postgres、BullMQ/Redis、S3 兼容对象存储、Qdrant、LlamaIndex、Model Context Protocol Streamable HTTP、现有 LangGraph/DeepAgent 与 Next.js AI UI。

**Spec:** docs/knowledge-graphrag.md

## Global Constraints

- 首期只支持 UTF-8 Markdown 和纯文本；PDF、DOCX、OCR 不进入本计划。
- agent_runs.knowledge_base_ids 是不可变 run 授权快照；resume job 不能读取新的 UI/session 选择。
- 所有知识查询先按 tenant_id 过滤；越权、跨租户和不存在资源统一返回 404。
- embedding 使用单一、启动后不可变的 profile；collection 名称必须含 profile 标识和维度。
- knowledge_index_jobs 同时是状态表和持久投递账本；BullMQ jobId 使用数据库 job ID，补偿扫描必须幂等。
- GraphRAG 工具固定命名为 graphrag_search，只读免审批只能精确匹配该受信工具。
- MCP 返回的 passage、structured content、事件 payload 都必须有数量和字符上限；事件不保存完整原文。
- apps/worker 不依赖 @repo/knowledge-graphrag；GraphRAG 失败不得终止通用 Agent runtime。
- 每个任务完成自己的测试和提交后，才开始下一个任务；实现步骤遵循失败测试 → 最小实现 → 通过测试。

## File Map

| 文件/目录 | 职责 |
|---|---|
| packages/contracts/src/index.ts | run job、引用和检索事件的跨进程契约 |
| packages/db/migrations/009_knowledge_base.sql | 知识库、文档、chunk、图谱、索引任务和检索日志表 |
| packages/db/src/schema.ts | Drizzle 表定义 |
| packages/db/src/repository.ts | Agent run 快照与 resume job |
| packages/db/src/knowledge-repository.ts | 知识库资源、索引任务和检索日志仓储 |
| packages/knowledge-graphrag/src/* | parser、chunker、graph、embedder、retriever、存储适配器和索引管线 |
| apps/knowledge-service/src/* | BullMQ consumer/reconciler 和 MCP HTTP server |
| apps/api/src/app.ts、routes.ts、types.ts、config.ts | API queue wiring、路由和上传限制 |
| apps/worker/src/config.ts、processor.ts | run token、MCP 注入和服务降级 |
| packages/agent-core/src/deep-agent.ts、types.ts | MCP 隔离、审批规则和 structured content 事件桥 |
| apps/web/app/components/resilient-chat/* | picker、引用 message part、历史恢复 |
| apps/web/app/knowledge/* | 轻量知识库管理页 |
| infra/compose.yaml、.env.example | Qdrant 和进程配置 |

## Task 1: Contracts, Migration, and Run Snapshot

**Files:**

- Modify: packages/contracts/src/index.ts
- Test: packages/contracts/test/contracts.test.ts
- Create: packages/db/migrations/009_knowledge_base.sql
- Modify: packages/db/src/schema.ts
- Modify: packages/db/src/repository.ts
- Test: packages/db/test/repository-shapes.test.ts

**Interfaces:**

- knowledgeBaseIdsSchema：最多 10 个 UUID，拒绝重复值；空值在内部归一化为 []。
- citationSchema：chunkId、documentId、documentName、ordinal、heading、score、via，字段和数组均有长度上限。
- relationCitationSchema：source、relation、target 和最多 10 个 chunkIds。
- retrievalCompletedSchema：retrievalId、toolCallId、knowledgeBaseIds、query、有限 citations/relations 和 stats；stats 固定包含 vectorHits、graphHops、searchedKbs、durationMs、truncated。
- knowledgeRunTokenClaimsSchema/type：tenantId、userId、sessionId、runId、kbIds、jti、exp、aud。
- RunJob 的三个分支都增加 knowledgeBaseIds: string[]。
- AgentRepository.createRun(context, { sessionId, message, knowledgeBaseIds?, idempotencyKey? }) 在同一事务中完成批量授权、run 插入和 start outbox。
- AgentRepository.resolveInterrupt 从 agent_runs.knowledge_base_ids 构造 resume job。
- RunRecord.knowledgeBaseIds 供 Worker 读取不可变快照。

- [ ] **Step 1: 写契约失败测试**

在 packages/contracts/test/contracts.test.ts 增加断言：有效 retrieval.completed 可解析；超过 10 个 kbId 被拒绝；重复 kbId 被拒绝；start、resume-approval、resume-question 都必须含 kbIds。

- [ ] **Step 2: 运行失败测试**

运行：pnpm --filter @repo/contracts test

预期：当前 schema 不认识 retrieval.completed 和 knowledgeBaseIds，新增断言失败。

- [ ] **Step 3: 写最小契约和迁移**

先定义 citation、relation、stats schema，再加入 agentEventSchema、createRunSchema 和三个 runJobSchema 分支；给 knowledgeBaseIds 加 Set 唯一性校验。

在 migration 009 创建 7 张知识表、tenant/kb/document/graph 索引、knowledge_documents 活动内容哈希部分唯一索引，并给 agent_runs 增加 knowledge_base_ids uuid[] NOT NULL DEFAULT '{}'。图实体和关系包含 document_id，chunk_ids 建 GIN index。

在 schema.ts 同步 Drizzle 定义。repository.ts 的 runOf 映射快照；createRun 锁住 session，按 tenant 和可读规则批量查询 KB，数量不一致抛 RepositoryNotFoundError('knowledge_base')，然后在同一事务写 run 和 outbox。resolveInterrupt 查询 run 快照并把它放进 resume job。

实现时保持以下事务形状，不能先提交 run 再补写 outbox：

```ts
const ids = [...new Set(input.knowledgeBaseIds ?? [])];
const visible = await client.query(
  'SELECT id FROM knowledge_bases WHERE tenant_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[]) AND (visibility = \'tenant\' OR owner_user_id = $3 OR $4::text[] && ARRAY[\'owner\', \'admin\']::text[])',
  [context.tenantId, ids, context.userId, context.roles],
);
if (visible.rowCount !== ids.length) throw new RepositoryNotFoundError('knowledge_base');
await client.query(
  'INSERT INTO agent_runs (id, tenant_id, user_id, session_id, status, user_message, knowledge_base_ids) VALUES ($1, $2, $3, $4, \'queued\', $5, $6::uuid[])',
  [runId, context.tenantId, context.userId, input.sessionId, input.message, ids],
);
await insertDispatch(client, { ...job, knowledgeBaseIds: ids });
```

- [ ] **Step 4: 运行通过测试**

运行：pnpm --filter @repo/contracts test && pnpm --filter @repo/db test

预期：契约测试全部通过；无数据库环境时原有 integration test 按仓库既有规则跳过。

- [ ] **Step 5: 提交**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/contracts.test.ts packages/db/migrations/009_knowledge_base.sql packages/db/src/schema.ts packages/db/src/repository.ts packages/db/test/repository-shapes.test.ts
git commit -m "feat: add knowledge graphrag contracts and run snapshots"
```

## Task 2: Pure GraphRAG Package

**Files:**

- Create: packages/knowledge-graphrag/package.json
- Create: packages/knowledge-graphrag/tsconfig.json and tsconfig.build.json
- Create: packages/knowledge-graphrag/src/types.ts
- Create: packages/knowledge-graphrag/src/parser/text.ts
- Create: packages/knowledge-graphrag/src/chunker/split.ts
- Create: packages/knowledge-graphrag/src/graph/in-memory.ts
- Create: packages/knowledge-graphrag/src/retriever/merge.ts
- Create: packages/knowledge-graphrag/src/index.ts
- Create: packages/knowledge-graphrag/test/parser.test.ts, chunker.test.ts, graph.test.ts, merge.test.ts

**Interfaces:**

- parseTextDocument(bytes: Uint8Array, mime: 'text/plain' | 'text/markdown'): ParsedDocument
- splitIntoChunks(document: ParsedDocument, options: { size: number; overlap: number }): TextChunk[]
- GraphStore：addExtraction(documentId, chunkId, extraction)、entityKeysForChunks、traverse(seedKeys, limits)、removeDocument。
- Embedder：profile、embedTexts(texts)、embedQuery(text)。
- mergeCandidates(vectorHits, graphResult, limits): CandidateEvidence[]
- stableChunkId(documentId, ordinal, text): string

- [ ] **Step 1: 写失败测试**

覆盖非法 UTF-8/二进制拒绝、Markdown 标题保留、chunk overlap 边界、稳定 chunk ID、demo 三跳关系、重复关系来源合并、fan-out/hop/relation 上限，以及向量和 graph 证据按 chunkId 去重并正确计算 via。

- [ ] **Step 2: 运行失败测试**

运行：pnpm --filter @repo/knowledge-graphrag test

预期：包尚不存在，命令失败。

- [ ] **Step 3: 创建包和最小实现**

复用 demo graph.ts 的 key 规范化、关系 ID、局部抽取合并和双向 BFS 语义，但把 Map 访问封装到 GraphStore；生产 Postgres store 不在本任务实现。

parser 只接受 UTF-8 Markdown/TXT；chunker 保留标题路径，默认使用 schema 的 size/overlap；stable ID 以 SHA-256 的前 16 字节生成，并设置 UUID version/variant 位后格式化。候选合并只保留向量命中和最终选中关系的来源 chunk，不能把所有 visited entity 来源加入结果。

核心导出保持无副作用，供 Task 3 的持久化适配器调用：

```ts
export function parseTextDocument(
  bytes: Uint8Array,
  mime: 'text/plain' | 'text/markdown',
): ParsedDocument;
export function splitIntoChunks(
  document: ParsedDocument,
  options: { size: number; overlap: number },
): TextChunk[];
export interface GraphStore {
  addExtraction(documentId: string, chunkId: string, extraction: GraphExtraction): void;
  entityKeysForChunks(chunkIds: Iterable<string>): Set<string>;
  traverse(seedKeys: Iterable<string>, limits: GraphLimits): GraphTraversal;
  removeDocument(documentId: string): void;
}
```

- [ ] **Step 4: 运行通过测试**

运行：pnpm --filter @repo/knowledge-graphrag test && pnpm --filter @repo/knowledge-graphrag typecheck

预期：四组纯函数测试通过，TypeScript 无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/knowledge-graphrag
git commit -m "feat: add bounded graphrag core algorithms"
```

## Task 3: Storage Adapters and Index Pipeline

**Files:**

- Modify: packages/knowledge-graphrag/package.json
- Create: packages/knowledge-graphrag/src/store/qdrant.ts
- Create: packages/knowledge-graphrag/src/store/postgres.ts
- Create: packages/knowledge-graphrag/src/indexer/pipeline.ts
- Create: packages/knowledge-graphrag/src/indexer/hash.ts
- Create: packages/knowledge-graphrag/test/qdrant.test.ts, hash.test.ts, pipeline.test.ts
- Create: packages/db/src/knowledge-repository.ts
- Modify: packages/db/src/index.ts
- Test: packages/db/test/knowledge-repository.test.ts

**Interfaces:**

- QdrantChunkStore.ensureCollection(profile)、upsert(points)、search(vector, filter, limit)、deleteByDocument(tenantId, kbId, documentId)。
- KnowledgeRepository.claimIndexJob(jobId, leaseMs)、markIndexStage、completeIndexJob、failIndexJob、getDocumentForIndex、replaceDocumentGraph、appendRetrievalLog。
- IndexPipeline.run(job, deps)：下载对象、计算真实 SHA-256、parse/chunk/embed/extract、写两库并完成状态迁移。
- EmbeddingProfile：key、model、dimension、collectionName；collection 必须由 profile hash + dimension 派生。

- [ ] **Step 1: 写失败测试**

用 fake Qdrant client 断言不同 profile 即使维度相同也得到不同 collection；search 必带 tenant/kb filter；重复 upsert 幂等；按 document 删除只影响该文档。用内存字节断言真实哈希不匹配会阻断 embedding。用 fake pipeline 断言 job 重试不会产生重复 chunk/graph 行。

对 KnowledgeRepository 增加 SQL integration test：跨 tenant 查询为空；claim 使用条件状态更新；同一活动 content_hash 被唯一索引拒绝；retrieval log citations 被限制。

- [ ] **Step 2: 运行失败测试**

运行：pnpm --filter @repo/knowledge-graphrag test && pnpm --filter @repo/db test

预期：新增模块未定义或 SQL 尚未实现，测试失败。

- [ ] **Step 3: 写最小实现**

新增 @qdrant/js-client-rest、@llamaindex/openai、llamaindex、zod、pg 等运行依赖。Qdrant adapter 创建 Cosine collection 和 payload index，tenant index 开启 is_tenant: true；Postgres adapter 所有方法显式接收 tenantId。

pipeline 对下载 bytes 重新计算 SHA-256，校验声明哈希、大小、UTF-8 和 MIME；先把 document 标记 parsing/chunking，再以稳定 chunk ID upsert。图谱按 document_id 写入 Postgres，全部完成后才标记 ready。重建在 MVP 中先清理旧 document 索引，失败则保持 failed；Qdrant 丢失只从 chunks 重新 embedding，不重新抽取图谱。

为 job 增加 lease_expires_at 条件更新；updated_at 超时任务可被 reconciler 重新 claim。KnowledgeRepository 单独放在新文件，避免扩大现有 AgentRepository。

Qdrant 查询必须由 adapter 合并租户和知识库条件，不能由调用方传入完整 filter：

```ts
async search(vector: number[], tenantId: string, kbIds: string[], limit: number) {
  return client.search(collectionName, {
    vector,
    limit,
    filter: { must: [
      { key: 'tenant_id', match: { value: tenantId } },
      { key: 'kb_id', match: { any: kbIds } },
    ] },
    with_payload: true,
  });
}
```

- [ ] **Step 4: 运行通过测试**

运行：pnpm --filter @repo/knowledge-graphrag test && pnpm --filter @repo/knowledge-graphrag typecheck && pnpm --filter @repo/db typecheck

预期：纯单元测试通过；真实 Postgres 测试仅在 RUN_INTEGRATION_TESTS=1 时执行。

- [ ] **Step 5: 提交**

```bash
git add packages/knowledge-graphrag packages/db/src/knowledge-repository.ts packages/db/src/index.ts packages/db/test/knowledge-repository.test.ts
git commit -m "feat: add graphrag storage and indexing pipeline"
```

## Task 4: Knowledge Service and MCP

**Files:**

- Create: apps/knowledge-service/package.json
- Create: apps/knowledge-service/tsconfig.json and tsconfig.build.json
- Create: apps/knowledge-service/src/config.ts
- Create: apps/knowledge-service/src/run-token.ts
- Create: apps/knowledge-service/src/consumer.ts
- Create: apps/knowledge-service/src/reconciler.ts
- Create: apps/knowledge-service/src/index.ts
- Create: apps/knowledge-service/src/mcp/server.ts
- Test: apps/knowledge-service/test/token.test.ts, mcp.test.ts, reconciler.test.ts

**Interfaces:**

- verifyRunToken(header, secret): KnowledgeRunTokenClaims，校验签名、audience、exp 和 kbIds。
- startKnowledgeService(config, deps): Promise<CloseableService>，同进程启动 BullMQ Worker、补偿扫描和 MCP HTTP server。
- MCP tool graphrag_search({ query }) 返回有界 text content 和 structuredContent。
- reconcileQueuedJobs(now, limit) 对 queued/stale jobs 以数据库 job ID 幂等补投。

- [ ] **Step 1: 写失败测试**

断言错误 secret、过期 token、tenant/run 不匹配返回 401；graphrag_search 不接受 kbIds 扩权；content 每条和总长度都截断；structuredContent 只包含 retrievalId/citations/relations/stats；已有相同 jobId 时补偿扫描不重复入队；索引器抛错后 job 进入 failed 而服务继续健康。

- [ ] **Step 2: 运行失败测试**

运行：pnpm --filter @repo/knowledge-service test

预期：应用包和 server 尚不存在，测试失败。

- [ ] **Step 3: 写最小实现**

knowledge-service package 增加 @modelcontextprotocol/sdk、bullmq、ioredis、jose 和 workspace 包依赖。服务配置包含 Qdrant、embedding profile、抽取模型、并发、预算、Redis、Postgres 和 token secret。BullMQ consumer 读取 knowledge-index queue，claim job 后调用 Task 3 pipeline；reconciler 定时扫描 queued/stale job，使用 queue.add('index', job, { jobId: job.id })。

使用 MCP Streamable HTTP transport 提供 /mcp 和 /healthz。请求只从 Authorization header 取 token，工具内部把 token kbIds 作为完整搜索集合，query 是唯一必需输入。content 文本加 [S1] 标签并限长；structuredContent 省略 passage。连接/任务失败记录指标，不让 HTTP server 退出。

工具处理器的输入边界固定为 query，不接受 caller 的 kbIds：

```ts
server.registerTool('graphrag_search', {
  inputSchema: { query: z.string().trim().min(1).max(MAX_QUERY_CHARS) },
}, async ({ query }, extra) => {
  const claims = await authenticateRequest(extra.requestInfo);
  const result = await retriever.retrieve({
    tenantId: claims.tenantId,
    knowledgeBaseIds: claims.kbIds,
    query,
  });
  return {
    content: [{ type: 'text', text: formatBoundedEvidence(result) }],
    structuredContent: boundedRetrievalMetadata(result),
  };
});
```

- [ ] **Step 4: 运行通过测试**

运行：pnpm --filter @repo/knowledge-service test && pnpm --filter @repo/knowledge-service typecheck

预期：token、MCP 和 reconciler 测试通过，server 可启动并响应 /healthz。

- [ ] **Step 5: 提交**

```bash
git add apps/knowledge-service
git commit -m "feat: add knowledge indexing and mcp service"
```

## Task 5: API Knowledge Resources and Queue Wiring

**Files:**

- Modify: apps/api/src/types.ts
- Modify: apps/api/src/config.ts
- Modify: apps/api/src/app.ts
- Modify: apps/api/src/server.ts
- Modify: apps/api/src/routes.ts
- Create: apps/api/src/knowledge-routes.ts
- Test: apps/api/test/knowledge-routes.test.ts
- Modify: apps/api/test/chat-stream.test.ts

**Interfaces:**

- ApiServices.knowledgeQueue: Queue，与现有 agent-runs queue 分离。
- registerKnowledgeRoutes(app, { repository, knowledgeQueue, artifacts, config })。
- KnowledgeRepository endpoints 每次接收 tenantId、userId、roles。
- 上传流程：createDocumentUpload → S3 presign → confirmDocumentUpload 原子创建 queued job → post-commit queue add。

- [ ] **Step 1: 写失败测试**

用 fastify.inject 覆盖：无权限 KB 不返回；跨租户 GET/DELETE 为 404；超过 KNOWLEDGE_DOCUMENT_MAX_BYTES 为 400；confirm 校验对象存在/大小；同一 confirm 只产生一个 active job；chat 带未知或无权限 kbId 为 404 且不产生 run；合法 kbIds 写入 run snapshot。

- [ ] **Step 2: 运行失败测试**

运行：pnpm --filter @repo/agent-api test

预期：知识库路由、queue wiring 和 chat body 字段尚不存在，新增测试失败。

- [ ] **Step 3: 写最小实现**

在 app.ts 创建独立 knowledge-index Queue，onClose 关闭它；types.ts 注入服务；server.ts 保持同一启动迁移。新增路由使用独立 knowledge object key 前缀，管理接口只允许 Markdown/TXT，确认阶段执行对象存在/大小初检，真实字节哈希由 indexer 复核。

修改 /api/chat request schema 接收 knowledge_base_ids，转为 createRun 的 knowledgeBaseIds。repository 在事务内批量授权和写 snapshot；API 只负责把错误映射为统一 404。confirm 事务写 document queued + index job，再提交后以 job ID 添加 BullMQ；API 崩溃窗口由 Task 4 reconciler 补偿。

- [ ] **Step 4: 运行通过测试**

运行：pnpm --filter @repo/agent-api test && pnpm --filter @repo/agent-api typecheck

预期：新增 route/transaction 测试和现有 API 测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add knowledge base api and indexing queue"
```

## Task 6: Worker and Agent Core MCP Bridge

**Files:**

- Modify: packages/agent-core/src/types.ts
- Modify: packages/agent-core/src/deep-agent.ts
- Test: packages/agent-core/test/deep-agent.test.ts
- Modify: apps/worker/src/config.ts
- Modify: apps/worker/src/processor.ts
- Test: apps/worker/test/processor.test.ts

**Interfaces:**

- HeadlessAgentOptions.knowledgeMcp: url、token、timeoutMs、enabled。
- extractRetrievalEvent(runId, toolCallId, toolName, output): AgentEvent | null。
- createDeepAgentRuntime 独立加载 base MCP 和可选 GraphRAG MCP，dispose 同时关闭两者。
- createRuntime 从 job.knowledgeBaseIds 生成 token claims；不信任模型提供的 kbIds。

- [ ] **Step 1: 写失败测试**

断言未启用或空 kbIds 不创建 GraphRAG client；GraphRAG connection error 不阻断 base tools；graphrag_search 自动免审批而 execute/未知同名工具仍需审批；ToolMessage structured content 生成含 retrievalId、toolCallId 和 citations 的 retrieval.completed；structured payload 超限被截断；dispose 关闭两个 client。

- [ ] **Step 2: 运行失败测试**

运行：pnpm --filter @repo/agent-core test && pnpm --filter @repo/agent-worker test

预期：现有 loadMcpTools 不支持 optional server 和 structured content，新增测试失败。

- [ ] **Step 3: 写最小实现**

Worker package 增加 jose 依赖。扩展 loadMcpTools 接受 server config 和 onConnectionError，base 与 GraphRAG 使用两个 client 实例；GraphRAG 工具加载失败时跳过该工具。审批规则以精确工具名 graphrag_search 为 key，只有该工具设为 false。

在 on_tool_end 分支保留现有 bounded printed output，同时从 ToolMessage artifact/content block 提取 structuredContent，调用 extractRetrievalEvent 产出契约事件。system prompt 仅在工具成功加载时加入检索、证据不足说明和不可信 passage 规则。新增 Worker config 的 URL、secret、timeout、enabled，并在每个 start/resume job 重新签发短时 token。

事件桥接必须在 tool.completed 之前产出，且没有 structuredContent 时返回 null：

```ts
const retrieval = extractRetrievalEvent(
  options.runId,
  invocationId,
  toolName,
  payload.output,
);
if (retrieval) yield retrieval;
yield {
  runId: options.runId,
  timestamp: timestamp(),
  type: 'tool.completed',
  invocationId,
  tool: toolName,
  output: normalizeToolOutput(payload.output),
};
```

- [ ] **Step 4: 运行通过测试**

运行：pnpm --filter @repo/agent-core test && pnpm --filter @repo/agent-worker test && pnpm --filter @repo/agent-core typecheck && pnpm --filter @repo/agent-worker typecheck

预期：新旧测试通过；Worker 在 GraphRAG 不可用时仍能写 terminal run event。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-core/src packages/agent-core/test apps/worker/src apps/worker/test
git commit -m "feat: bridge graphrag mcp into agent runtime"
```

## Task 7: SSE, History, and Web UI

**Files:**

- Modify: apps/api/src/chat-stream.ts
- Modify: apps/api/src/routes.ts
- Modify: apps/web/app/components/resilient-chat/types.ts
- Modify: apps/web/app/components/resilient-chat/chat-runtime.tsx
- Modify: apps/web/app/components/resilient-chat/utils.ts
- Modify: apps/web/app/components/resilient-chat/events.ts
- Modify: apps/web/app/components/resilient-chat/api.ts
- Modify: apps/web/app/components/resilient-chat/message.tsx
- Create: apps/web/app/components/resilient-chat/knowledge-base-picker.tsx
- Create: apps/web/app/components/resilient-chat/citation-list.tsx
- Create: apps/web/app/knowledge/page.tsx
- Create: apps/web/app/knowledge/knowledge-manager.tsx
- Modify: apps/web/app/styles/topbar.css and message.css
- Test: apps/api/test/chat-stream.test.ts
- Modify: apps/web/package.json
- Create: apps/web/test/knowledge-state.test.ts

**Interfaces:**

- HistoryMessage.citations?: Citation[]。
- fetchKnowledgeBases(signal?)、createKnowledgeBase(input)、uploadKnowledgeDocument(kbId, file)、deleteKnowledgeBase(kbId)。
- data-citations message part 携带 bounded retrieval.completed data 且为 non-transient。
- messagesFromHistory 在 assistant text 后追加同一 data-citations part。

- [ ] **Step 1: 写失败测试**

API stream test 断言 retrieval.completed 同时保留 transient data-agent 并追加非 transient data-citations，且引用不携带 passage。history route test 断言同一 run 的 retrieval events 汇总到 assistant message。Web pure test 断言选择器 toggle 保持其他选择，history citation part 可被渲染状态读取。

- [ ] **Step 2: 运行失败测试**

运行：pnpm --filter @repo/agent-api test && pnpm --filter web test

预期：chunksFrom 目前只发 transient agent event，HistoryMessage 只有 text，新增测试失败。先在 web package 增加现有 workspace 可用的 tsx devDependency，并把 test script 改为 node --import tsx --test test/**/*.test.ts。

- [ ] **Step 3: 写最小实现**

chat-stream.ts 遇到 retrieval.completed 时额外发 data-citations，继续发 transient data-agent 以保留过程轨迹。历史 API 在每个 run 的事件组中筛 retrieval events，映射 citations 到 assistant HistoryMessage；types.ts 和 utils.ts 重建对应 UIMessage part。

在 chat-runtime.tsx 的 topbar-actions 加 picker，选择按 chatId 本地保存并由 prepareSendMessagesRequest 发送 knowledge_base_ids。events.ts 为 retrieval 增加简短 trace。message.tsx 渲染 citation-list，显示文档名、ordinal/heading、score 和 via，不直接显示未审计原文。知识管理页只实现列表、新建、Markdown/TXT 上传、状态和删除，复用现有 fetch/error 样式。

stream chunk 的最小形状如下，引用数据只出现于 data-citations：

```ts
if (event.type === 'retrieval.completed') {
  chunks.push({ type: 'data-citations', data: event, transient: false });
}
chunks.push({ type: 'data-agent', data: event, transient: true });
```

- [ ] **Step 4: 运行通过测试**

运行：pnpm --filter @repo/agent-api test && pnpm --filter web test && pnpm --filter web typecheck

预期：stream/history/API 测试通过，Next 类型检查通过，未选择 KB 时 picker 不改变原请求语义。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/chat-stream.ts apps/api/src/routes.ts apps/api/test apps/web/app apps/web/test
git commit -m "feat: render persistent graphrag citations in chat"
```

## Task 8: Infrastructure and End-to-End Verification

**Files:**

- Modify: infra/compose.yaml
- Modify: .env.example
- Modify: apps/knowledge-service/package.json (build/start scripts and runtime dependencies)
- Create: apps/knowledge-service/test/e2e-smoke.test.ts (guarded by RUN_KNOWLEDGE_E2E=1)

**Interfaces:**

- Local Qdrant service on a dedicated port and persistent volume.
- knowledge-index queue uses existing Redis.
- API/Worker/knowledge-service environment variables follow section 10 of the spec.

- [ ] **Step 1: 写失败 smoke test**

RUN_KNOWLEDGE_E2E=1 时执行：创建 KB → presign/upload Markdown → confirm → 等待 ready → 用 run token 调 graphrag_search → 检查 citations → 删除 Qdrant points 后重新 embedding → 检查图谱未丢。未设置变量时必须 skip。

- [ ] **Step 2: 运行失败测试**

运行：RUN_KNOWLEDGE_E2E=1 pnpm --filter @repo/knowledge-service test

预期：Qdrant、Postgres、Redis 和 S3 尚未补齐时 smoke test 失败。

- [ ] **Step 3: 写最小基础设施配置**

compose 增加 qdrant/qdrant service、健康检查和 named volume；不替换现有 Postgres 镜像。env.example 按 API、Worker、knowledge-service 分组加入 document limit、Qdrant、profile、MCP URL/secret/timeout、抽取并发和预算。

补齐 knowledge-service build/start scripts，确认 workspace 自动发现新 apps/*/packages/*，不改 turbo.json。执行迁移并启动依赖后运行 smoke test。

本地 Qdrant service 配置至少包含：

```yaml
qdrant:
  image: qdrant/qdrant:latest
  ports: ["56333:6333"]
  volumes: [agent-qdrant:/qdrant/storage]
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:6333/healthz"]
```

- [ ] **Step 4: 运行完整验证**

运行：

```bash
pnpm typecheck
pnpm test
pnpm build
RUN_KNOWLEDGE_E2E=1 pnpm --filter @repo/knowledge-service test
```

预期：workspace typecheck/test/build 全部成功；E2E smoke 通过；若本机 Node 26 仍无法编译可选 canvas，记录为已有可选依赖警告，不把它归因于 GraphRAG。

- [ ] **Step 5: 提交**

```bash
git add infra/compose.yaml .env.example apps/knowledge-service/package.json apps/knowledge-service/test/e2e-smoke.test.ts
git commit -m "chore: add graphrag local infrastructure and smoke test"
```

## Final Self-Review Checklist

- [ ] 文档中的所有 MVP 验收标准都能在 Task 1–8 找到对应测试或实现步骤。
- [ ] 没有把 PDF/DOCX/OCR、multi-profile、rerank、generation 切换或缓存偷偷带入首期。
- [ ] agent_runs 快照贯穿 start、approval resume、question resume。
- [ ] retrieval.completed 在 contracts、Agent Core、SSE、history 和 Web 类型中保持同一字段名。
- [ ] tenant_id、run token、Qdrant filter 和 API 404 规则四层一致。
- [ ] 所有索引 job 都有稳定 ID、状态迁移、失败记录和补偿路径。
- [ ] 只读免审批不按模糊工具名或整个 MCP server 放行。
- [ ] 只有验证命令全部通过后，才可以声称 MVP 完成。
