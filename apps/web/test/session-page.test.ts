import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSessionPage, sessionBelongsToChat } from '../app/components/resilient-chat/api';

test('restoration validates a native session absent from the loaded sidebar page', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    id: 'native-second-page', externalKey: null,
  }), { status: 200 }));
  assert.equal(await sessionBelongsToChat('native-second-page', 'native-second-page', []), true);
  assert.equal(await sessionBelongsToChat('native-second-page', 'another-chat', []), false);
});

test('restoration still checks web chat keys and rejects inaccessible sessions', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    id: 'session-id', externalKey: 'web-chat',
  }), { status: 200 }));
  assert.equal(await sessionBelongsToChat('session-id', 'web-chat', []), true);
  assert.equal(await sessionBelongsToChat('session-id', 'session-id', []), false);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await sessionBelongsToChat('session-id', 'web-chat', []), false);
});

test('session pages retain native sessions with a stable chat identity', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    data: [{ id: 'native-id', externalKey: null }, { id: 'web-id', externalKey: 'web-chat' }],
    nextCursor: 'older',
  }), { status: 200 }));
  const page = await fetchSessionPage();
  assert.deepEqual(page.data.map(({ id, externalKey }) => ({ id, externalKey })), [
    { id: 'native-id', externalKey: 'native-id' }, { id: 'web-id', externalKey: 'web-chat' },
  ]);
  assert.equal(page.nextCursor, 'older');
});
