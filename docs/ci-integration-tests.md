# Critical integration gate

The `integration` job in `.github/workflows/ci.yml` runs independently of the unit/typecheck/build and Web E2E jobs. GitHub Actions provisions a fresh PostgreSQL 17 database named `agent_ci_test` and Redis 7.4 instance, waits for both health checks, and runs the integration runner on Node.js 22. The services expose PostgreSQL at port `55433` and Redis at `56379` on the runner. Their state lasts only for that job.

`pnpm test:integration` validates explicit `DATABASE_URL` and `REDIS_URL`, applies database migrations, and then runs these suites in order:

1. Every `*.integration.test.ts` under `packages/db/test`, including nested directories.
2. Every `*.integration.test.ts` under `apps/worker/test`, including the mandatory `fenced-checkpointer.integration.test.ts` and execution compatibility/memory-polling recovery tests.
3. `packages/agent-core/test/durable-crash.e2e.test.ts`, including the three controlled SIGKILL/recovery scenarios.

The runner sets `RUN_INTEGRATION_TESTS=1`, passes both service URLs to every subprocess, and maps `REDIS_URL` to the crash fixture's `DURABLE_E2E_REDIS_URL`. It invokes the migration entry point directly and never loads `.env`. Test files and suites run serially because migrations and recovery polling share the isolated database. Logs identify each selected file and include Node's TAP results and suite totals. A failing process, missing mandatory file, empty database file selection, file with no declared test cases, skipped/cancelled/todo case, or missing test summary fails the gate; test-filter arguments are refused.

The database guard requires `test` as a complete component of the database name, separated by `_` or `-` when other components exist: `agent_test`, `agent_ci_test`, and `test_chat` are accepted. Names such as `agent`, `production`, `latest`, and `contest_production` are rejected before any migration or connection. Credentials are omitted from configuration logs. Test-labelled databases must still be dedicated disposable infrastructure; the name guard cannot determine whether a database contains valuable data.

## Local execution

Provision a dedicated PostgreSQL 17 database and Redis 7 instance before running the command. The integration script does not start or stop infrastructure. For already-running isolated services using the same local ports:

```sh
DATABASE_URL=postgresql://agent:agent@127.0.0.1:55433/agent_test \
REDIS_URL=redis://127.0.0.1:56379/15 \
pnpm test:integration
```

The local Redis example selects logical database `15`; use an instance/database reserved for tests. Override both URLs when dedicated services use other ports. `DATABASE_TEST_URL` is not read by this runner; pass the selected URL explicitly as `DATABASE_URL`.

Validate the guard and file selection without contacting either service:

```sh
DATABASE_URL=postgresql://agent:agent@127.0.0.1:55433/agent_test \
REDIS_URL=redis://127.0.0.1:56379/15 \
pnpm test:integration --check
```

Run the runner's regression tests without database/Redis services:

```sh
node --test scripts/run-integration-tests.test.mjs
```

These tests execute the real runner in subprocesses against temporary fixtures to check database refusal, exact suite selection, explicit environment propagation, migration/integration failures, and accidental skips. They require installed workspace dependencies for the `tsx` loader.

## Failure diagnosis

- A configuration refusal occurs before migrations: set the two explicit test URLs and a database name containing a separate `test` component.
- A migration or integration process failure preserves that process's exit status and output, and later suites do not run.
- A skipped/cancelled/todo or missing summary means the mandatory suite did not execute completely; inspect the preceding TAP output instead of treating the underlying Node exit status as a successful gate.
- SIGKILL is intentional in the crash fixtures. A test fails if the worker never reaches its controlled crash point or if recovery repeats an uncertain external effect.

Branch protection should require the `integration` job alongside the existing quality jobs so a failed durable-execution gate blocks merging.
