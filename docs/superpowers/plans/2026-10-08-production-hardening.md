# Production Hardening Implementation Plan

> Execute task-by-task using test-driven-development and independent agent work for disjoint file ownership.

**Goal:** Implement the eight production hardening findings and verify the resulting flows.
**Architecture:** Retain the fenced PostgreSQL/BullMQ/LangGraph architecture. Centralize durable business invariants, secure preview boundaries, make recovery compatibility explicit, and bound read/stream resources.
**Tech Stack:** TypeScript, Node, Fastify, PostgreSQL, BullMQ, LangGraph, Next.js, React Native.
**Spec:** `docs/superpowers/specs/2026-10-08-production-hardening-design.md`

## Global Constraints

- Preserve `docs/项目优化.md` and unrelated user changes.
- No deployment, external provider requests, or changes to credentials.
- Persist before publish; checkpoint ownership remains fenced.
- Maintain existing client fields while adding bounded pagination.
- Parent-attached background children retain their current product semantics.
- Every changed behavior has a meaningful regression test; record commands/results.

## Task 1: Secure preview and rebuild

Files: `apps/api/src/app.ts`, new `apps/api/src/preview-routes.ts`, `apps/api/src/routes.ts`, preview tests; native preview opening if needed.

- [x] Exercise anonymous, wrong-user, external-key and symlink preview requests; confirm missing protections fail.
- [x] Extract preview routes, enforce session authorization, remove broad anonymous path bypass, and reject symlink traversal including root directories.
- [x] Preserve authenticated Web iframe access; add a restricted short-lived capability for native browser opening if cookies are unavailable.
- [x] Run route tests and API typecheck.

## Task 2: Repository invariants, versioning and task view

Files: `packages/db/src/repository.ts`, `packages/db/src/durable-execution.ts`, schema/migrations, DB tests; `apps/worker/src/processor.ts`, `worker.ts`, new execution compatibility helpers.

- [x] Test cross-user/session idempotency, changed payload reuse, concurrent requests, atomic memory creation and child cancellation.
- [x] Add canonical request fingerprints and scoped unique identity; return `RepositoryConflictError('idempotency_conflict')` for payload mismatch.
- [x] Atomically create memory extraction intent with Run completion; poll durable memory jobs even without Redis notification.
- [x] Persist/check non-secret execution descriptor before runtime effects; test compatible and incompatible restart with explicit failure code.
- [x] Expose `listRunTasks(context, runId)` returning authorized children and waiting/owner metadata.
- [x] Run DB/Worker tests, migrations and recovery integration tests.

## Task 3: Conservative tool replay and Agent boundaries

Files: `packages/agent-core/src/tool-execution.ts`, `deep-agent.ts`, `subagent.ts`, new capabilities/adapters modules, Agent tests.

- [x] Change regression expectations: session auto-approval never silently repeats unknown unsafe effects; MCP annotations do not establish replay safety; stored/current policy must both be safe.
- [x] Implement these rules while retaining approval identities and successful-result reuse.
- [x] Extract business prompt and memory/preview tools, retain existing public exports, and centralize recovery adapter behavior.
- [x] Make attached child cancel/complete behavior explicit, bounded and recoverable; document semantics.
- [x] Run Agent tests and typecheck.

## Task 4: Critical CI gate

Files: `.github/workflows/ci.yml`, root scripts/package.json, integration runner/docs.

- [x] Introduce a dedicated PostgreSQL/Redis job with health checks, isolated URLs and `RUN_INTEGRATION_TESTS=1`.
- [x] Ensure runner invokes @repo/db, @repo/agent-worker and @repo/agent-core integration/crash tests, and refuses a non-test database URL.
- [x] Verify the runner's guard and execute suites locally on isolated infrastructure when available.

## Task 5: Bounded history and SSE

Files: new shared event projection, DB projection migration/repository, `apps/api/src/chat-stream.ts`, `sse.ts`, history routes, Web/mobile history consumers.

- [x] Test snapshot replacement, pagination continuity, >page-size replay, slow-client drain, disconnect and timeout cleanup.
- [x] Persist/rebuild message projections, add keyset history pages, and update clients to load older pages on demand through the bounded API.
- [x] Add a shared bounded SSE writer and paginated replay, preserving existing stream framing and cursor behavior.
- [x] Coalesce text persistence under bounded limits and flush before non-text events; verify ordering and lossless text.
- [x] Run API/DB/client tests and typecheck.

## Task 6: Integration and final review

- [x] Review all changes against the eight requested findings and resolve integration conflicts.
- [x] Run all changed-package tests, typechecks, relevant builds and real recovery suites.
- [x] Add operational instructions for compatibility failure, task inspection and new environment settings.
- [x] Record completed tasks, evidence and remaining environmental limitations in this plan.


## Final Verification — 2026-10-08

- `pnpm lint`: exit 0, no errors; 17 existing-style warnings remain in the Web lint output.
- `pnpm typecheck`: 14/14 workspace tasks succeeded.
- `pnpm test`: 14/14 workspace tasks succeeded; 574 declared tests, 563 passed, 0 failed, 11 infrastructure-dependent cases skipped in the default command.
- Mandatory real integration runner on a newly created isolated PostgreSQL 17 database and Redis 7.4, using Node 22.23.3: 39 passed, 0 failed/skipped (34 DB, 2 Worker, 3 Agent SIGKILL). All migrations applied to the fresh database.
- Integration runner subprocess guards: 11 passed, including Node 22 verification.
- `pnpm build`: 13/13 workspace build tasks succeeded. Built Agent runtime descriptor imports correctly under Node 22 without development export conditions.
- Full Web Playwright E2E with local Google Chrome: 20 passed, including history/files pagination and existing stream/session isolation recovery. Bundled Playwright Chromium crashed at startup on this Mac; local Chrome was used without changing CI browser configuration.
- Production preview containment/racing directory replacement and file byte budget: 2 passed in an isolated Linux Node 22 Docker container. macOS tests verify production refusal and development behavior.
- Real Docker rebuild route with a local offline build executable, followed by authenticated capability preview: passed. No provider/model requests were made.
- Agent implementation independently reviewed the root SSE writer/coalescer and recovery prefix logic; its buffered-error text loss finding was fixed and tested. Root cross-module review additionally reproduced and fixed pre-graph preparation crash recovery using a creation-time execution contract marker, absence of event/tool/child execution evidence, and descriptor comparison. Old/inconsistent execution records still refuse recovery.
- A separate final review agent could not start because its service usage limit was reached. The root completed the remaining source review and integration validation; no independent final-review verdict is claimed.
- `git diff --check`: passed. User-owned `docs/项目优化.md` preserved. No commits or deployments performed.

## Compatibility and Operations

See `docs/production-hardening.md`, `docs/history-pagination.md` and `docs/ci-integration-tests.md`. Apply migrations before Worker/API/client deployment. Existing executions without a safe descriptor fail conservatively; remote MCP discovery precedes graph/tool execution but follows sandbox preparation. Production workspace previews require Linux. Capacity/load testing and production deployment are outside this local repair task.
