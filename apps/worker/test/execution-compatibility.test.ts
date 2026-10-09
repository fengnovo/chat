import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunJob } from '@repo/contracts';
import { loadWorkerConfig } from '../src/config.js';
import { createRunProcessor } from '../src/processor.js';
import { buildHostExecutionDescriptor } from '../src/execution-compatibility.js';

const job: RunJob = { kind: 'start', tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333', runId: '44444444-4444-4444-8444-444444444444', message: 'test', workspacePath: '/tmp/workspace', attachments: [], knowledgeBaseIds: [], approvalMode: 'manual' };

test('granting session approval does not change deployment compatibility', async () => {
  const config = loadWorkerConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'test-key' });
  const manual = await buildHostExecutionDescriptor(config, job);
  const approved = await buildHostExecutionDescriptor(config, { ...job, approvalMode: 'session' });
  assert.deepEqual(approved, manual);
});

test('host descriptors include effective configuration and resource contents while excluding credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'execution-descriptor-'));
  try {
    const skills = path.join(root, 'skills');
    await mkdir(path.join(skills, 'research'), { recursive: true });
    await writeFile(path.join(skills, 'research', 'SKILL.md'), 'original skill');
    const memory = path.join(root, 'AGENTS.md'); await writeFile(memory, 'prompt content');
    const mcp = path.join(root, 'mcp.json');
    await writeFile(mcp, JSON.stringify({ mcpServers: { search: { transport: 'http', url: 'https://tools.invalid/mcp', args: ['--endpoint', 'https://tools.invalid/mcp?api_key=first-secret'], headers: { Authorization: 'Bearer first-secret' }, env: { API_KEY: 'first-secret' } } } }));
    const environment = { NODE_ENV: 'test', OPENAI_API_KEY: 'first-secret', KNOWLEDGE_MCP_SECRET: 'first-secret', AGENT_MEMORY_FILE: memory, AGENT_SKILLS_DIR: skills, MCP_CONFIG_PATH: mcp };
    const first = await buildHostExecutionDescriptor(loadWorkerConfig(environment), job);
    await writeFile(mcp, JSON.stringify({ mcpServers: { search: { transport: 'http', url: 'https://tools.invalid/mcp', args: ['--endpoint', 'https://tools.invalid/mcp?api_key=rotated-secret'], headers: { Authorization: 'Bearer rotated-secret' }, env: { API_KEY: 'rotated-secret' } } } }));
    const rotated = await buildHostExecutionDescriptor(loadWorkerConfig({ ...environment, OPENAI_API_KEY: 'rotated-secret', KNOWLEDGE_MCP_SECRET: 'rotated-secret' }), job);
    assert.deepEqual(rotated, first);
    assert.ok(!JSON.stringify(first).includes('first-secret'));
    assert.ok(!JSON.stringify(rotated).includes('rotated-secret'));
    assert.notDeepEqual(await buildHostExecutionDescriptor(loadWorkerConfig({ ...environment, MODEL: 'openai:another-model' }), job), first);
    assert.notDeepEqual(await buildHostExecutionDescriptor(loadWorkerConfig({ ...environment, TOOL_REPLAY_POLICIES: '{"search":{"replaySafe":true}}' }), job), first);
    await writeFile(path.join(skills, 'research', 'SKILL.md'), 'changed skill');
    assert.notDeepEqual(await buildHostExecutionDescriptor(loadWorkerConfig(environment), job), first);
    await writeFile(path.join(skills, 'research', 'SKILL.md'), 'original skill');
    await writeFile(memory, 'changed prompt');
    assert.notDeepEqual(await buildHostExecutionDescriptor(loadWorkerConfig(environment), job), first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('incompatible execution terminally fails before sandbox acquisition instead of retrying', async () => {
  let status = 'running';
  const events: unknown[] = [];
  const config = loadWorkerConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'test-key' });
  const services = {
    config,
    repository: {
      getRunForWorker: async () => ({ status }),
      markDispatchConsumed: async () => undefined,
      getWorkspaceSandboxForWorker: async () => { throw new Error('sandbox access occurred before compatibility'); },
      durable: {
        claimRun: async () => ({ tenantId: job.tenantId, runId: job.runId, input: job, token: 'token', epoch: 2, recovery: true }),
        bindExecutionDescriptor: async () => { throw Object.assign(new Error('runtime changed'), { code: 'RECOVERY_INCOMPATIBLE' }); },
        appendEvent: async (_lease: unknown, event: { type: string; code?: string }) => { events.push(event); status = 'failed'; return { ...event, seq: 1 }; },
        releaseLease: async () => undefined,
      },
    },
    redis: { set: async () => 'OK', eval: async () => 1 },
    publisher: { publish: async () => undefined },
    controllers: new Map(),
  } as never;
  await createRunProcessor(services)({ id: 'dispatch', data: job } as never);
  assert.equal(status, 'failed');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { code: string }).code, 'RECOVERY_INCOMPATIBLE');
});
