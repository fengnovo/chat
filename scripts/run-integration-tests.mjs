import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const nodeOptions = ['--conditions=development', '--import', 'tsx'];

function requireUrl(name, protocols) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} must be explicitly set to an isolated test service URL.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid ${protocols.join(' or ')} URL.`); }
  if (!protocols.includes(url.protocol) || !url.hostname) {
    throw new Error(`${name} must be a valid ${protocols.join(' or ')} URL with a hostname.`);
  }
  return url;
}

function environment() {
  const database = requireUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
  let name;
  try { name = decodeURIComponent(database.pathname.slice(1)); } catch { name = ''; }
  if (!/^[a-z0-9_-]+$/i.test(name) || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) {
    throw new Error('Refusing to migrate or run integration suites: DATABASE_URL must name a test database (for example agent_ci_test).');
  }
  const redis = requireUrl('REDIS_URL', ['redis:', 'rediss:']);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    RUN_INTEGRATION_TESTS: '1',
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    // The SIGKILL fixture currently consumes this name rather than REDIS_URL.
    DURABLE_E2E_REDIS_URL: process.env.REDIS_URL,
  };
  // Prevent inherited preloads or test filters from altering the mandatory suites.
  delete env.NODE_OPTIONS;
  return { env, name, database, redis };
}

async function integrationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await integrationFiles(filename));
    else if (entry.isFile() && entry.name.endsWith('.integration.test.ts')) files.push(filename);
  }
  return files.sort();
}

async function suites() {
  const databaseRoot = path.join(repository, 'packages/db');
  const workerRoot = path.join(repository, 'apps/worker');
  const dbFiles = await integrationFiles(path.join(databaseRoot, 'test'));
  const workerFiles = await integrationFiles(path.join(workerRoot, 'test'));
  if (!dbFiles.length) throw new Error('@repo/db has no integration test files; refusing an empty CI gate.');
  const result = [
    { name: '@repo/db', directory: databaseRoot, files: dbFiles },
    { name: '@repo/agent-worker', directory: workerRoot, files: workerFiles },
    { name: '@repo/agent-core', directory: path.join(repository, 'packages/agent-core'), files: [path.join(repository, 'packages/agent-core/test/durable-crash.e2e.test.ts')] },
  ];
  if (!workerFiles.includes(path.join(workerRoot, 'test/fenced-checkpointer.integration.test.ts'))) {
    throw new Error('Missing mandatory integration test: apps/worker/test/fenced-checkpointer.integration.test.ts');
  }
  for (const suite of result) {
    for (const filename of suite.files) {
      if (!(await stat(filename)).isFile()) throw new Error(`Missing mandatory integration test: ${path.relative(repository, filename)}`);
    }
  }
  return result;
}

async function execute(label, args, directory, env, testFiles) {
  console.log(`\n[integration] ${label}`);
  const summary = {};
  const emptyFiles = new Set();
  let pending = '';
  const parse = (line) => {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
    if (match) summary[match[1]] = Number(match[2]);
    const subtest = /^# Subtest: (.+)$/.exec(line);
    // Node reports an empty file as one successful test named after its path.
    if (subtest && testFiles?.some((file) => subtest[1] === file || subtest[1] === path.relative(directory, file))) {
      emptyFiles.add(subtest[1]);
    }
  };
  const child = spawn(process.execPath, [...nodeOptions, ...args], {
    cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) parse(line);
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (pending) parse(pending);
  if (code !== 0) {
    throw Object.assign(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`}).`), { exitCode: code || 1 });
  }
  if (testFiles) {
    if (emptyFiles.size) throw new Error(`${label} has no declared test cases in: ${[...emptyFiles].join(', ')}.`);
    if (!(summary.tests > 0) || summary.fail !== 0 || summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0) {
      throw new Error(`${label} did not run all mandatory cases: tests=${summary.tests ?? 'missing'}, failures=${summary.fail ?? 'missing'}, cancelled=${summary.cancelled ?? 'missing'}, skipped=${summary.skipped ?? 'missing'}, todo=${summary.todo ?? 'missing'}.`);
    }
    console.log(`[integration] ${label} passed: ${summary.tests} tests, 0 skipped.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--check')) {
    throw new Error('Usage: node scripts/run-integration-tests.mjs [--check]; test-filter arguments are not accepted.');
  }
  const config = environment();
  const selected = await suites();
  console.log(`[integration] Test database ${config.name} at ${config.database.hostname}:${config.database.port || '5432'}; Redis at ${config.redis.hostname}:${config.redis.port || '6379'}.`);
  for (const suite of selected) {
    console.log(`[integration] ${suite.name}: ${suite.files.map((file) => path.relative(repository, file)).join(', ')}`);
  }
  if (args[0] === '--check') {
    console.log('[integration] Configuration checked; no connections or migrations performed.');
    return;
  }
  await execute('Test database migrations', ['src/migrate.ts'], selected[0].directory, config.env);
  // Serialize files/suites because migrations and recovery pollers share one isolated database.
  for (const suite of selected) {
    await execute(suite.name, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...suite.files], suite.directory, config.env, suite.files);
  }
  console.log('\n[integration] All mandatory integration suites passed.');
}

main().catch((error) => {
  console.error(`[integration] ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
});
