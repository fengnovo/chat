import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiClient } from '../src/api/client';

test('approval API sends once/session scope and question preserves multi-select payload', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url!, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = new ApiClient();
    api.configure(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'test',
    );
    await api.respondApproval('r', 'a', true, 'session');
    await api.respondApproval('r', 'b', true);
    await api.respondApproval('r', 'c', false, 'session');
    const selections = [
      { index: 0, label: '苹果' },
      { index: 2, label: '香蕉' },
    ];
    await api.respondQuestion('r', 'q', selections, '橙子');
    assert.deepEqual(requests, [
      {
        url: '/api/agent/runs/r/approvals/a',
        body: { decision: 'approve', scope: 'session' },
      },
      {
        url: '/api/agent/runs/r/approvals/b',
        body: { decision: 'approve', scope: 'once' },
      },
      {
        url: '/api/agent/runs/r/approvals/c',
        body: { decision: 'reject', scope: 'once' },
      },
      {
        url: '/api/agent/runs/r/questions/q',
        body: { selections, customText: '橙子' },
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
