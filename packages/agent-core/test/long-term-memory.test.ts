import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLongTermMemoryBackend } from '../src/index.js';
import { createMemoryTools } from '../src/capabilities/memory.js';
import { createPreviewPageTool } from '../src/capabilities/preview.js';

test('buildLongTermMemoryBackend mounts a persistent store under /memories', () => {
  const backend = buildLongTermMemoryBackend({
    defaultBackend: {} as never,
    store: {} as never,
    namespace: ['keen-ai', 'v1', 'tenant-a', 'user-a', 'chat', 'global'],
  });
  assert.deepEqual(backend.routePrefixes, ['/memories/']);
  assert.equal(typeof backend.execute, 'function');
});

test('memory capabilities validate explicit writes and preserve the storage result', async () => {
  const remembered: unknown[] = [];
  const forgotten: string[] = [];
  const tools = createMemoryTools({ store: {}, namespace: ['user'],
    remember: async (input) => { remembered.push(input); return 'memory saved'; },
    forget: async (id) => { forgotten.push(id); return true; },
  });
  const remember = tools.find((item) => item.name === 'remember_fact')!;
  const forget = tools.find((item) => item.name === 'forget_memory')!;
  await assert.rejects(() => remember.invoke({ content: '', kind: 'preference' }));
  assert.equal(await remember.invoke({ content: 'Use TypeScript', kind: 'preference', normalizedKey: 'language' }), 'memory saved');
  assert.deepEqual(remembered, [{ content: 'Use TypeScript', kind: 'preference', normalizedKey: 'language' }]);
  const id = 'd579ae60-09fd-44a5-a6c8-7442c1b83f62';
  assert.equal(await forget.invoke({ memoryId: id }), true);
  assert.deepEqual(forgotten, [id]);
  assert.deepEqual(createMemoryTools(undefined), []);
});

test('preview capability returns the URI consumed by the existing preview button', async () => {
  const result = await createPreviewPageTool().invoke({ message: 'Home page' });
  assert.match(result, /\[📺 打开页面预览\]\(preview:\/\/open\)/);
});
