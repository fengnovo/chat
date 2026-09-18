# Long-Term Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DeepAgent Chat 增加按租户/用户/项目隔离的可检索长期记忆，并支持后台整理、显式记住/忘记、审计和 fail-open。

**Architecture:** 保留现有 LangGraph PostgresSaver 作为 thread 级短期记忆；新增 `packages/memory-core` 负责策略、提取、渲染和检索，PostgreSQL 作为记忆事实源，Qdrant 作为派生语义索引。Worker 运行前召回，run 完成后通过 BullMQ memory job 异步整理。

**Tech Stack:** TypeScript 5.9, Deep Agents 1.13.x, LangGraph PostgresStore/PostgresSaver, PostgreSQL, Redis/BullMQ, Qdrant, Zod, Node test runner。

**Spec:** `docs/long-term-memory-design.md`

## Global Constraints

- 所有 memory 查询和写入必须带 `tenantId` 与 `userId`，项目记忆额外带 `projectId`。
- 记忆系统任何异常都不得使主聊天失败；后台任务必须可重试和可对账。
- 不保存凭证、Token、Cookie、私钥或完整思维过程。
- 先写失败测试并运行确认失败，再写生产实现。
- 不修改现有知识库 collection；个人记忆使用独立 namespace/collection。

---

### Task 1: Memory contracts and pure policy helpers

**Files:**
- Create: `packages/memory-core/src/types.ts`
- Create: `packages/memory-core/src/policy.ts`
- Create: `packages/memory-core/src/profile-renderer.ts`
- Create: `packages/memory-core/test/policy.test.ts`
- Create: `packages/memory-core/test/profile-renderer.test.ts`
- Create: `packages/memory-core/package.json`
- Create: `packages/memory-core/tsconfig.json`

**Interfaces:**
- Produce `MemoryScope`, `MemoryKind`, `MemoryRecord`, `MemoryOperation`, `MemoryQuery`, `MemoryPolicy` and pure functions `memoryNamespace()`, `isSensitiveMemory()`, `renderProfile()`.

- [ ] Write failing tests for namespace isolation, sensitive credential rejection, operation validation, profile ordering and token/length truncation.
- [ ] Run `pnpm --filter @repo/memory-core test` and confirm failure because package/functions are absent.
- [ ] Implement Zod schemas and deterministic policy helpers without database or LLM dependencies.
- [ ] Run the package tests and confirm pass.
- [ ] Run `pnpm --filter @repo/memory-core typecheck`.

### Task 2: PostgreSQL schema and repository

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/repository.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/migrations/013_long_term_memory.sql`
- Create: `packages/db/test/memory-repository.test.ts`

**Interfaces:**
- Produce repository methods `listMemories`, `getMemory`, `upsertMemory`, `supersedeMemory`, `deleteMemory`, `clearMemories`, `enqueueMemoryJob`, `claimMemoryJob`, `completeMemoryJob`.

- [ ] Write failing repository-shape and tenant-isolation tests using the existing database test conventions.
- [ ] Run the focused DB tests and confirm failure before implementation.
- [ ] Add tables, indexes and partial unique index for active `normalized_key`.
- [ ] Implement parameterized repository methods with explicit tenant/user/project predicates and optimistic version checks.
- [ ] Add migration discovery coverage and run `pnpm --filter @repo/db test`.
- [ ] Run DB typecheck.

### Task 3: Retrieval and profile persistence

**Files:**
- Create: `packages/memory-core/src/repository.ts`
- Create: `packages/memory-core/src/retriever.ts`
- Create: `packages/memory-core/src/profile-store.ts`
- Create: `packages/memory-core/test/retriever.test.ts`
- Modify: `packages/memory-core/src/index.ts`

**Interfaces:**
- Produce `MemoryRepositoryPort`, `MemoryVectorIndexPort`, `MemoryRetriever.retrieve()`, `MemoryProfileStore.read/write()`.

- [ ] Write failing tests for global + project scope merge, status filtering, top-k truncation, vector failure fail-open and profile read/write.
- [ ] Run focused memory tests and confirm failure.
- [ ] Implement repository-port adapters and deterministic ranking (`score`, `importance`, `confidence`, recency).
- [ ] Implement profile storage over LangGraph `BaseStore` compatible `StoreBackend` namespace.
- [ ] Run package tests and typecheck.

### Task 4: DeepAgent runtime integration

**Files:**
- Modify: `packages/agent-core/src/types.ts`
- Modify: `packages/agent-core/src/deep-agent.ts`
- Modify: `packages/agent-core/src/index.ts`
- Create: `packages/agent-core/test/long-term-memory.test.ts`
- Modify: `apps/worker/src/processor.ts`
- Modify: `apps/worker/src/worker.ts`

**Interfaces:**
- Extend `HeadlessAgentOptions` with optional `longTermMemory?: { store; namespace; profilePath; context; tools }`.
- Produce a composite sandbox + `/memories/` StoreBackend and read-only permissions for profile files.

- [ ] Write failing runtime assembly tests proving store/backend/memory/permissions are passed and missing memory is fail-open.
- [ ] Run focused agent-core tests and confirm failure.
- [ ] Instantiate process-level `PostgresStore`, call `setup`, and pass it to DeepAgent.
- [ ] Retrieve memory context before runtime creation and inject it as untrusted system context.
- [ ] Add explicit memory tools behind the existing tool policy.
- [ ] Run agent-core and worker typechecks/tests.

### Task 5: Background extraction and BullMQ delivery

**Files:**
- Create: `packages/memory-core/src/extractor.ts`
- Create: `packages/memory-core/src/consolidator.ts`
- Create: `apps/worker/src/memory-consumer.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/processor.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/memory-core/test/consolidator.test.ts`

**Interfaces:**
- Produce `extractMemoryOperations()` with structured Zod output and `consolidateMemoryOperations()` with idempotent upsert/supersede/delete.

- [ ] Write failing tests for explicit-fact extraction, sensitive filtering, contradiction update, duplicate run idempotency and index retry.
- [ ] Run focused tests and confirm failure.
- [ ] Implement extraction using the configured model router or a low-cost configured model, with no raw prompt telemetry.
- [ ] Add a dedicated BullMQ memory queue/consumer and terminal-run job enqueue.
- [ ] Add reconciler for completed runs with missing memory jobs.
- [ ] Run worker tests and typecheck.

### Task 6: API and UI memory management

**Files:**
- Modify: `apps/api/src/routes.ts`
- Modify: `apps/api/src/types.ts`
- Create: `apps/api/src/memory-routes.ts`
- Create: `apps/api/test/memory-routes.test.ts`
- Create: `apps/web/app/memory/page.tsx`
- Create: `apps/web/app/components/memory-manager.tsx`

**Interfaces:**
- Add authenticated endpoints for list, update, delete, clear and settings; every endpoint must use the existing `request.auth` tenant/user context.

- [ ] Write failing API tests for auth, tenant isolation, update/delete/clear and settings.
- [ ] Implement routes and web controls with explicit user confirmation for clear-all.
- [ ] Run API tests and web typecheck/tests.

### Task 7: End-to-end verification and observability

**Files:**
- Modify: `apps/worker/src/agent-telemetry.ts`
- Modify: `apps/worker/src/observability.ts`
- Create: `packages/memory-core/test/memory-flow.integration.test.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] Add spans/metrics for `memory.retrieve`, `memory.extract`, `memory.upsert` with low-cardinality attributes only.
- [ ] Add integration coverage for cross-session recall, cross-user isolation, forget, retry and fail-open.
- [ ] Run `pnpm test`, `pnpm typecheck`, and the memory integration test suite.
- [ ] Update configuration and operational documentation.
- [ ] Review the implementation against every requirement in `docs/long-term-memory-design.md`.
