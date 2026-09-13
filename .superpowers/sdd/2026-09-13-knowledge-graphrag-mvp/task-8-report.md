# Task 8 report

## RED → GREEN

- RED: `RUN_KNOWLEDGE_E2E=1 pnpm --filter @repo/knowledge-service test` ran the real smoke flow and failed at the unavailable API (`POST /api/knowledge-bases` returned 404); 9 existing tests passed and the smoke test failed.
- GREEN (guarded/default): `pnpm --filter @repo/knowledge-service test` passed 9 tests and explicitly skipped the smoke test because `RUN_KNOWLEDGE_E2E` was not set.
- The smoke test performs KB creation, presigned Markdown upload/confirm, ready polling, authenticated `graphrag_search` citation checks, Qdrant point deletion, rebuild search, and graph-relation preservation when local dependencies are running.

## Changes

- Added dedicated Qdrant `qdrant/qdrant:latest` service on `56333`, healthcheck, and `agent-qdrant` named volume; existing Postgres services remain unchanged.
- Added API/Worker/knowledge-service environment groups, including document limits, shared Redis queue name, MCP URL/secret/timeout, Qdrant/profile, extraction concurrency, and budget controls.
- Added knowledge-service `start` script and GraphRAG runtime dependencies.

## Verification

- `docker compose -f infra/compose.yaml config`: passed.
- `pnpm --filter @repo/knowledge-service typecheck`: passed.
- `pnpm test`: passed; knowledge-service smoke explicitly skipped without the guard variable.
- `pnpm build`: blocked by pre-existing `apps/web/app/components/resilient-chat/icon.tsx` missing a default export (Turbopack route entry); no GraphRAG/canvas attribution.
- Guarded E2E currently blocked because API/worker/Postgres/Redis/S3/Qdrant services are not running/configured in this workspace.

## Review follow-up

- Worker environment names now match `apps/worker/src/config.ts` exactly (`KNOWLEDGE_MCP_*`); the knowledge-service keeps its own `KNOWLEDGE_TOKEN_SECRET`.
- After deleting Qdrant points, smoke calls the existing document `confirm` API to enqueue a new index job, waits for `ready`, then searches again and compares graph relations. No fake rebuild/pass is used.
- `pnpm-lock.yaml` was regenerated for the knowledge-service importer and validated with frozen installation.
- Frozen verification command: `pnpm install --frozen-lockfile --offline` passed.
