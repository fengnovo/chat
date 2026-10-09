import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const runner = path.join(repository, 'scripts/run-integration-tests.mjs');
const databaseUrl = 'postgresql://ci:secret@127.0.0.1:55433/agent_ci_test';
const redisUrl = 'redis://127.0.0.1:56379/15';

function run(script = runner, args = ['--check'], overrides = {}) {
  const env = { ...process.env };
  for (const name of ['DATABASE_URL', 'DATABASE_TEST_URL', 'REDIS_URL', 'DURABLE_E2E_REDIS_URL', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[name];
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, ...overrides },
    encoding: 'utf8', timeout: 30_000,
  });
}

test('refuses missing explicit service URLs before running migrations', () => {
  for (const env of [{ DATABASE_URL: '' }, { REDIS_URL: '' }]) {
    const result = run(runner, ['--check'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL|REDIS_URL/);
    assert.doesNotMatch(result.stderr, /Cannot find module/);
  }
});

test('refuses production and misleading database names without exposing credentials', () => {
  for (const name of ['agent', 'production', 'latest', 'contest_production', 'agent_test/production', 'agent_test%2Fproduction']) {
    const result = run(runner, ['--check'], { DATABASE_URL: `postgresql://ci:private-password@127.0.0.1:55433/${name}` });
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /test database/i);
    assert.doesNotMatch(result.stderr, /private-password/);
  }
});

test('rejects invalid database and Redis protocols', () => {
  for (const env of [{ DATABASE_URL: 'https://localhost/agent_test' }, { REDIS_URL: 'https://localhost/15' }]) {
    const result = run(runner, ['--check'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /postgres|redis/i);
  }
});

test('check mode validates the three mandatory suites without contacting services', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@repo\/db/);
  assert.match(result.stdout, /durable-execution\.integration\.test\.ts/);
  assert.match(result.stdout, /mobile-title\.integration\.test\.ts/);
  assert.match(result.stdout, /session-management\.integration\.test\.ts/);
  assert.match(result.stdout, /fenced-checkpointer\.integration\.test\.ts/);
  assert.match(result.stdout, /durable-crash\.e2e\.test\.ts/);
  assert.doesNotMatch(result.stdout, /secret/);
});

test('refuses caller-supplied test filters that could silently remove mandatory cases', () => {
  const result = run(runner, ['--test-skip-pattern=SIGKILL']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /argument|usage/i);
});

async function fixture(t, { databaseTest, migration } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-integration-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  const fixtureRunner = path.join(directory, 'scripts/run-integration-tests.mjs');
  await copyFile(runner, fixtureRunner);
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(directory, '.env'), 'DATABASE_URL=postgresql://ci:ci@localhost/production\nREDIS_URL=redis://localhost:1\n');
  const record = path.join(directory, 'executions.jsonl');
  const recordCode = `import { appendFileSync } from 'node:fs';
    const record = (stage) => appendFileSync(process.env.RUNNER_TEST_RECORD, JSON.stringify({
      stage, database: process.env.DATABASE_URL, redis: process.env.REDIS_URL,
      crashRedis: process.env.DURABLE_E2E_REDIS_URL, enabled: process.env.RUN_INTEGRATION_TESTS,
    }) + '\\n');`;
  const successfulTest = (stage) => `${recordCode}
    import assert from 'node:assert/strict'; import test from 'node:test';
    test('${stage}', () => {
      assert.equal(process.env.RUN_INTEGRATION_TESTS, '1');
      assert.equal(process.env.DATABASE_URL, ${JSON.stringify(databaseUrl)});
      assert.equal(process.env.REDIS_URL, ${JSON.stringify(redisUrl)});
      assert.equal(process.env.DURABLE_E2E_REDIS_URL, ${JSON.stringify(redisUrl)});
      record('${stage}');
    });`;
  for (const packagePath of ['packages/db', 'apps/worker', 'packages/agent-core']) {
    await mkdir(path.join(directory, packagePath, 'test'), { recursive: true });
    await writeFile(path.join(directory, packagePath, 'package.json'), '{"type":"module"}');
    await symlink(path.join(repository, 'packages/db/node_modules'), path.join(directory, packagePath, 'node_modules'), 'dir');
    await writeFile(path.join(directory, packagePath, 'test/unrelated.test.ts'), 'throw new Error("unrelated suite must not run");');
  }
  await mkdir(path.join(directory, 'packages/db/src'), { recursive: true });
  await writeFile(path.join(directory, 'packages/db/src/migrate.ts'), migration ?? `${recordCode} record('migration');`);
  await writeFile(path.join(directory, 'packages/db/test/repository.integration.test.ts'), databaseTest ?? successfulTest('database'));
  await mkdir(path.join(directory, 'packages/db/test/nested'), { recursive: true });
  await writeFile(path.join(directory, 'packages/db/test/nested/additional.integration.test.ts'), successfulTest('nested-database'));
  await writeFile(path.join(directory, 'apps/worker/test/fenced-checkpointer.integration.test.ts'), successfulTest('checkpoint'));
  await writeFile(path.join(directory, 'apps/worker/test/execution-recovery.integration.test.ts'), successfulTest('execution-recovery'));
  await writeFile(path.join(directory, 'packages/agent-core/test/durable-crash.e2e.test.ts'), successfulTest('crash-recovery'));
  return { runner: fixtureRunner, record, env: { RUNNER_TEST_RECORD: record, RUN_INTEGRATION_TESTS: '0', DURABLE_E2E_REDIS_URL: 'redis://localhost:1' } };
}

test('migrates and runs every database integration file, checkpoint and crash suites with explicit isolation', async (t) => {
  const workspace = await fixture(t);
  const result = run(workspace.runner, [], workspace.env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const records = (await readFile(workspace.record, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records[0].stage, 'migration');
  assert.deepEqual(records.slice(1).map(({ stage }) => stage).sort(), ['checkpoint', 'crash-recovery', 'database', 'execution-recovery', 'nested-database']);
  for (const entry of records) {
    assert.equal(entry.database, databaseUrl);
    assert.equal(entry.redis, redisUrl);
    assert.equal(entry.crashRedis, redisUrl);
    assert.equal(entry.enabled, '1');
  }
  assert.match(result.stdout, /@repo\/db.*passed/);
  assert.match(result.stdout, /@repo\/agent-worker.*passed/);
  assert.match(result.stdout, /@repo\/agent-core.*passed/);
});

test('propagates migration failure and never starts integration suites afterward', async (t) => {
  const workspace = await fixture(t, { migration: 'console.error("controlled migration failure"); process.exit(7);' });
  const result = run(workspace.runner, [], workspace.env);
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stderr, /controlled migration failure/);
  await assert.rejects(readFile(workspace.record), { code: 'ENOENT' });
});

test('propagates a real integration assertion failure and stops later suites', async (t) => {
  const workspace = await fixture(t, { databaseTest: `import test from 'node:test'; import assert from 'node:assert/strict';
    test('controlled integration failure', () => assert.equal(1, 2));` });
  const result = run(workspace.runner, [], workspace.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /controlled integration failure/);
  const records = (await readFile(workspace.record, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.every(({ stage }) => !['checkpoint', 'crash-recovery'].includes(stage)));
});

test('fails when a mandatory suite skips a case even though Node returns success', async (t) => {
  const workspace = await fixture(t, { databaseTest: `import test from 'node:test';
    test('accidentally disabled integration case', { skip: true }, () => {});` });
  const result = run(workspace.runner, [], workspace.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /skip/i);
  const records = (await readFile(workspace.record, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.every(({ stage }) => !['checkpoint', 'crash-recovery'].includes(stage)));
});

test('fails when a selected integration file declares no test cases', async (t) => {
  const workspace = await fixture(t, { databaseTest: '// Accidentally empty integration suite.\n' });
  const result = run(workspace.runner, [], workspace.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no test cases|no declared test/i);
});

test('refuses an empty database suite selection and a missing mandatory checkpoint file', async (t) => {
  const empty = await fixture(t);
  await rm(path.join(path.dirname(empty.runner), '../packages/db/test'), { recursive: true });
  await mkdir(path.join(path.dirname(empty.runner), '../packages/db/test'));
  const emptyResult = run(empty.runner);
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /no integration test files/);

  const missing = await fixture(t);
  await rm(path.join(path.dirname(missing.runner), '../apps/worker/test/fenced-checkpointer.integration.test.ts'));
  const missingResult = run(missing.runner);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /fenced-checkpointer/);
});
