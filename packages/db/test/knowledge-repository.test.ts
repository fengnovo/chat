import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeRepository, ForbiddenKnowledgeError } from '../src/knowledge-repository.js';

test('repository methods include tenant predicates and bound retrieval citations', async () => {
  const queries: string[] = [];
  const pool: any = { query: async (text: string) => { queries.push(text); if (/knowledge_bases/i.test(text)) return { rows: [], rowCount: 0 }; if (/knowledge_documents/i.test(text) && /SELECT/i.test(text)) return { rows: [], rowCount: 0 }; return { rows: [{ id: 'job' }], rowCount: 1 }; } };
  const repo = new KnowledgeRepository(pool);
  await repo.claimIndexJob('t', 'job', 1000);
  await repo.appendRetrievalLog({ tenantId: 't', userId: 'u', sessionId: 's', runId: 'r', retrievalId: 'x', kbIds: [], query: 'q', topK: 1, maxHops: 0, resultCount: 0, rerankStatus: 'none', citations: Array.from({ length: 100 }, (_, i) => ({ id: i })), latencyMs: 1, status: 'ok' });
  assert.ok(queries.some((q) => /tenant_id/i.test(q)));
});

test('claim returns a lease token and stale worker transitions are rejected', async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool: any = { query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [{ id: 'job' }], rowCount: 1 }; } };
  const repo = new KnowledgeRepository(pool);
  const first = await repo.claimIndexJob('tenant-a', 'job', 1000);
  const second = await repo.claimIndexJob('tenant-a', 'job', 1000);
  assert.ok(first && second && first.leaseToken !== second.leaseToken);
  assert.equal(await repo.completeIndexJob('tenant-a', 'job', first.leaseToken, 1), false);
  assert.equal(await repo.completeIndexJob('tenant-a', 'job', second.leaseToken, 1), true);
  assert.match(String(queries[0]?.text), /tenant_id/);
});

test('failed job atomically marks its document failed', async () => {
  const sql: string[] = [];
  const pool: any = { query: async (text: string) => { sql.push(text); return { rows: [{ id: 'job' }], rowCount: 1 }; } };
  const repo = new KnowledgeRepository(pool);
  const lease = await repo.claimIndexJob('tenant-a', 'job', 1000);
  assert.ok(lease);
  await repo.failIndexJob('tenant-a', 'job', lease.leaseToken, new Error('bad bytes'));
  assert.ok(sql.some((q) => /knowledge_documents/i.test(q) && /failed/i.test(q)));
});

test('terminal transition is one atomic SQL statement', async () => {
  const queries: string[] = [];
  const pool: any = { query: async (text: string) => { queries.push(text); return { rows: [{ id: 'job' }], rowCount: 1 }; } };
  const repo = new KnowledgeRepository(pool);
  const lease = await repo.claimIndexJob('tenant-a', 'job', 1000);
  assert.ok(lease);
  await repo.completeIndexJob('tenant-a', 'job', lease.leaseToken, 2);
  assert.equal(queries.filter((q) => /knowledge_index_jobs/i.test(q) && /knowledge_documents/i.test(q)).length, 1);
  assert.match(queries.at(-1)!, /WITH|RETURNING/i);
});

test('knowledge API repository exposes authorized CRUD and atomic upload confirmation', async () => {
  const queries: string[] = [];
  const pool: any = { query: async (text: string) => { queries.push(text); if (/knowledge_index_jobs.*status/i.test(text)) return { rows: [], rowCount: 0 }; return { rows: [{ id: 'kb', document_id: 'doc', job_id: 'job' }], rowCount: 1 }; } };
  const repo = new KnowledgeRepository(pool);
  const auth = { tenantId: 'tenant', userId: 'user', roles: [] };
  await repo.listKnowledgeBases(auth);
  await repo.getKnowledgeDocument(auth, 'kb', 'doc');
  await repo.confirmDocumentUpload(auth, 'kb', 'doc', { sizeBytes: 1, sha256: 'a'.repeat(64) });
  assert.ok(queries.some((q) => /knowledge_bases/i.test(q) && /tenant_id/i.test(q)));
  assert.ok(queries.some((q) => /knowledge_index_jobs/i.test(q) && /BEGIN|COMMIT|INSERT/i.test(q)));
});

test('createDocumentUpload reuses the existing document row when the same content hash is imported twice', async () => {
  const queries: string[] = [];
  const pool: any = {
    query: async (text: string) => {
      queries.push(text);
      if (/FROM knowledge_bases/i.test(text)) return { rows: [{ id: 'kb' }], rowCount: 1 };
      if (/INSERT INTO knowledge_documents/i.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM knowledge_documents/i.test(text)) return { rows: [{ id: 'existing-doc', object_key: 'tenants/t/knowledge/kb/existing-doc/x.md' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const repo = new KnowledgeRepository(pool);
  const auth = { tenantId: 'tenant', userId: 'admin', roles: ['admin'] };
  const reused = await repo.createDocumentUpload(auth, { kbId: 'kb', documentId: 'new-doc', name: 'x.md', mime: 'text/markdown', sizeBytes: 1, sha256: 'a'.repeat(64), objectKey: 'tenants/t/knowledge/kb/new-doc/x.md', directory: 'dishes' });
  assert.equal(reused?.id, 'existing-doc');
  assert.ok(queries.some((q) => /INSERT INTO knowledge_documents/i.test(q) && /ON CONFLICT \(kb_id, content_hash\)/i.test(q) && /DO NOTHING/i.test(q)));
  assert.ok(queries.some((q) => /SELECT \* FROM knowledge_documents WHERE kb_id=\$1 AND content_hash=\$2/i.test(q)));
});

test('regular tenant members cannot upload or confirm in another owner tenant-visible KB', async () => {
  const queries: string[] = [];
  const pool: any = { query: async (text: string) => { queries.push(text); return { rows: [], rowCount: 0 }; } };
  const repo = new KnowledgeRepository(pool);
  const auth = { tenantId: 'tenant', userId: 'member', roles: [] };
  assert.equal(await repo.createDocumentUpload(auth, { kbId: 'kb', documentId: 'doc', name: 'x.md', mime: 'text/markdown', sizeBytes: 1, sha256: 'a'.repeat(64), objectKey: 'x' }), null);
  assert.equal(await repo.confirmDocumentUpload(auth, 'kb', 'doc', { sizeBytes: 1, sha256: 'a'.repeat(64) }), null);
  assert.equal(queries.some((q) => /INSERT INTO knowledge_documents|INSERT INTO knowledge_index_jobs/i.test(q)), false);
  assert.ok(queries.every((q) => !/visibility = 'tenant'/i.test(q) || /owner_user_id|ARRAY\['owner','admin'\]/i.test(q)));
  assert.ok(queries.some((q) => /knowledge_bases/i.test(q) && /owner_user_id/i.test(q) && !/visibility = 'tenant'/i.test(q)));
});

test('createKnowledgeBase persists the injected embedding profile without model or collection SQL constants', async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool: any = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows: [{ id: values[0] }], rowCount: 1 };
    },
  };
  const profile = {
    key: 'bailian-v4',
    model: 'text-embedding-v4',
    dimension: 1024,
    collectionName: 'knowledge_0123456789abcdef_1024',
  };
  const repo = new KnowledgeRepository(pool, { embeddingProfile: profile });
  await repo.createKnowledgeBase(
    { tenantId: 'tenant', userId: 'user', roles: ['owner'] },
    { id: 'kb', name: 'KB' },
  );

  assert.doesNotMatch(queries[0]!.text, /text-embedding-3-small|1536|\$1,800/);
  assert.deepEqual(queries[0]!.values.slice(6, 10), [
    profile.key,
    profile.model,
    profile.dimension,
    profile.collectionName,
  ]);
});

test('createKnowledgeBase refuses to invent an embedding profile when none is injected', async () => {
  let queried = false;
  const repo = new KnowledgeRepository({ query: async () => { queried = true; return { rows: [] }; } } as any);
  await assert.rejects(
    () => repo.createKnowledgeBase(
      { tenantId: 'tenant', userId: 'user', roles: ['owner'] },
      { id: 'kb', name: 'KB' },
    ),
    /embedding profile/i,
  );
  assert.equal(queried, false);
});

test('createKnowledgeBase is limited to owner and admin roles', async () => {
  const repo = new KnowledgeRepository({ query: async () => ({ rows: [] }) } as any, {
    embeddingProfile: {
      key: 'k',
      model: 'm',
      dimension: 1,
      collectionName: 'c',
    },
  });
  await assert.rejects(
    () => repo.createKnowledgeBase(
      { tenantId: 'tenant', userId: 'user', roles: ['member'] },
      { id: 'kb', name: 'KB' },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ForbiddenKnowledgeError);
      return true;
    },
  );
});

test('asset confirm and delete bind exactly the placeholders their permission predicate uses', async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool: any = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return { rows: [{ id: 'asset' }], rowCount: 1 };
    },
  };
  const repo = new KnowledgeRepository(pool);
  const auth = { tenantId: 'tenant', userId: 'user', roles: [] };

  await repo.confirmAssetUpload(auth, 'kb', 'asset', { sizeBytes: 1, sha256: 'a'.repeat(64) });
  await repo.deleteKnowledgeAsset(auth, 'kb', 'asset');

  assert.ok(queries.length >= 3, 'confirm + delete 至少产生 3 条语句');
  for (const { text, values } of queries) {
    const placeholders = Array.from(text.matchAll(/\$(\d+)/g), (match) => Number(match[1]));
    if (!placeholders.length) continue;
    // 权限片段里写错的占位符编号会让 PG 报 "bind message supplies N parameters"，只会以 500 暴露。
    assert.equal(values.length, Math.max(...placeholders), `参数数量与占位符不匹配：${text}`);
  }
});
