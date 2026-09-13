# Task 5 Report — Knowledge Base API and Index Queue

## RED → GREEN

- RED: added `fastify.inject` tests for authorization/not-found behavior, upload size limits, object verification, and confirm idempotency. Before implementation, the API suite failed because `apps/api/src/knowledge-routes.ts` did not exist (`ERR_MODULE_NOT_FOUND`).
- GREEN: added knowledge-base/document routes, Markdown/TXT upload validation, object verification before confirm, post-commit BullMQ enqueue with stable job IDs, independent knowledge queue lifecycle, and `/api/chat` knowledge-base selection forwarding.

## Verification

- `pnpm --filter @repo/agent-api test` — 15 passed, 0 failed.
- `pnpm --filter @repo/agent-api typecheck` — passed.
- `git diff --check` — passed.

## Commit

Initial commit: `c1ef356` — `feat: add knowledge base api and indexing queue`

## Fix round 1 (P0 production composition)

- RED: added a DB repository contract test; it failed because the knowledge API methods were absent.
- GREEN: `KnowledgeRepository` now implements mandatory tenant/user/role-authorized KB/document CRUD, upload creation, and atomic confirm (queued document plus deduplicated active index job). `server.ts` constructs and injects it from the real database pool; unsafe optional-method fallback was removed.
- Verification: API tests 15 passed; DB tests 10 passed with 1 pre-existing integration skip; API and DB typechecks passed; `git diff --check` passed.

## Fix round 2 (write authorization)

- RED: added a regression for a regular tenant member writing to another owner's `visibility='tenant'` KB; it failed before the authorization predicate was tightened.
- GREEN: upload creation and confirm now require the KB owner or `owner`/`admin` role, while reads retain tenant visibility. The confirm lock query also excludes soft-deleted KBs.
- Verification: API tests 15 passed; DB tests 11 passed with 1 pre-existing integration skip; API and DB typechecks passed; `git diff --check` passed.

## Fix round 3 (faithful route regression)

- RED: added a Fastify inject regression with an existing tenant-visible KB owned by another user; before the guard it returned 500/attempted writes instead of uniform 404.
- GREEN: routes now perform a mandatory owner/admin write authorization check before presigning or object verification. The test asserts upload and confirm both return 404 with zero artifact and queue activity; DB authorization coverage remains in place.
- Verification: API tests 16 passed; DB tests 11 passed with 1 pre-existing integration skip; API and DB typechecks passed; `git diff --check` passed.
