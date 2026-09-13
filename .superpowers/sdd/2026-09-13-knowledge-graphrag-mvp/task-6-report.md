# Task 6 Report — Worker and Agent Core MCP Bridge

## RED → GREEN

- RED: added structured retrieval and Worker GraphRAG configuration tests. Agent-core failed because `extractRetrievalEvent` was not exported; Worker config returned `undefined` instead of the disabled default.
- GREEN: added optional isolated GraphRAG MCP loading, exact `graphrag_search` approval bypass, bounded `retrieval.completed` emission before `tool.completed`, dual-client disposal, Worker defaults, and short-lived HS256 tokens signed only from `job.knowledgeBaseIds`.

## Verification

- `pnpm --filter @repo/agent-core test` — 11 passed, 0 failed.
- `pnpm --filter @repo/agent-worker test` — 16 passed, 0 failed.
- `pnpm --filter @repo/agent-core typecheck` — passed.
- `pnpm --filter @repo/agent-worker typecheck` — passed.
- `git diff --check` — passed.

## Fix round 1

- RED: explicit `KNOWLEDGE_MCP_ENABLED='false'` regression failed under `z.coerce.boolean()` (`true !== false`).
- GREEN: environment parsing now accepts only explicit `true`/`false`; failed MCP initialization closes its partially-created client before falling back.
- Verification: agent-core and worker tests/typechecks passed; `git diff --check` passed.
