import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSessionPage } from '../app/components/resilient-chat/api';

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
