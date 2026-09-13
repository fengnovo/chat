import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startKnowledgeService } from '../src/index.js';

const config: any = { port: 0, tokenSecret:'0123456789012345', redisUrl:'redis://x', postgresUrl:'postgres://x', qdrantUrl:'http://x', embeddingProfile:'p', extractionModel:'m', concurrency:1, budget:1 };
class FakeServer extends EventEmitter { listening = false; listen(_p: number, cb: () => void) { this.listening = true; cb(); return this; } close(cb: (e?: Error) => void) { this.listening = false; cb(); } }
test('service close cleans HTTP and dependencies even when worker close fails', async () => {
  const server = new FakeServer(); let queueClosed = false, redisClosed = false;
  const service = await startKnowledgeService(config, { server, worker:{ close: async () => { throw new Error('worker') } }, queue:{ close: async () => { queueClosed = true } }, connection:{ quit: async () => { redisClosed = true } } });
  await service.close(); assert.equal(server.listening, false); assert.equal(queueClosed, true); assert.equal(redisClosed, true);
});
test('listen failure rejects and closes worker', async () => {
  const server = new FakeServer(); let closed = false;
  server.listen = function (this: FakeServer) { queueMicrotask(() => this.emit('error', new Error('bind'))); return this as any; } as any;
  await assert.rejects(() => startKnowledgeService(config, { server, worker:{ close: async () => { closed = true } } }), /bind/); assert.equal(closed, true);
});
