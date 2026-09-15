import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startKnowledgeService } from '../src/index.js';
import { createMcpHttpServer } from '../src/mcp/server.js';

const config: any = { port: 0, tokenSecret:'0123456789012345', redisUrl:'redis://x', postgresUrl:'postgres://x', qdrantUrl:'http://x', embeddingProfile:'p', extractionModel:'m', concurrency:1, budget:1 };
class FakeServer extends EventEmitter { listening = false; closeCount = 0; listen(_p: number, _host: string | undefined, cb: () => void) { this.listening = true; cb(); return this; } close(cb: (e?: Error) => void) { this.closeCount++; this.listening = false; cb(); } }
test('service close cleans HTTP and dependencies even when worker close fails', async () => {
  const server = new FakeServer(); let queueClosed = false, redisClosed = false;
  const service = await startKnowledgeService(config, { server, worker:{ close: async () => { throw new Error('worker') } }, queue:{ close: async () => { queueClosed = true } }, connection:{ quit: async () => { redisClosed = true } } });
  await service.close(); assert.equal(server.listening, false); assert.equal(server.closeCount, 1); assert.equal(queueClosed, true); assert.equal(redisClosed, true);
});
test('listen failure rejects and closes every received dependency', async () => {
  const server = new FakeServer(); let closed = false, queueClosed = false, redisClosed = false;
  server.listen = function (this: FakeServer) { queueMicrotask(() => this.emit('error', new Error('bind'))); return this as any; } as any;
  await assert.rejects(() => startKnowledgeService(config, { server, worker:{ close: async () => { closed = true } }, queue:{ close: async () => { queueClosed = true } }, connection:{ quit: async () => { redisClosed = true } } }), /bind/); assert.equal(closed, true); assert.equal(server.closeCount, 1); assert.equal(queueClosed, true); assert.equal(redisClosed, true);
});
test('healthz remains available after consumer pipeline failure', async () => {
  let processor: any; let runs = 0;
  class Worker { on() { return this; } constructor(_q: string, fn: any) { processor = fn; } async close() {} }
  const server = createMcpHttpServer({ tokenSecret:'0123456789012345', retriever:{ retrieve: async () => ({ citations:[], relations:[], stats:{} }) } });
  const service = await startKnowledgeService(config, { server, WorkerClass:Worker, connection:{}, repository:{ claimIndexJob: async () => ({ leaseToken:'l' }) }, pipeline:{ run: async () => { runs++; if (runs === 1) throw new Error('boom'); } }, metrics:{ indexFailure() {} } });
  try { await assert.rejects(() => processor({ id:'j', data:{ tenantId:'t' } }), /boom/); const port = (server.address() as any).port; const response = await fetch(`http://127.0.0.1:${port}/healthz`); assert.equal(response.status, 200); } finally { await service.close(); }
});
