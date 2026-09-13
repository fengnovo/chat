import type { EmbeddingProfile, VectorHit } from '../types.js';
import { collectionForProfile } from '../embedder/profile.js';

export { collectionForProfile } from '../embedder/profile.js';

export interface QdrantPoint { id: string; vector: number[]; payload: Record<string, unknown> }
export interface QdrantClientLike { getCollections(): Promise<any>; createCollection(name: string, config: any): Promise<any>; createPayloadIndex(name: string, field: string, config: any): Promise<any>; upsert(name: string, body: any): Promise<any>; search(name: string, body: any): Promise<any[]>; delete(name: string, body: any): Promise<any> }

export class QdrantChunkStore {
  private collectionName = '';
  constructor(private readonly client: QdrantClientLike, private readonly options: { prefix?: string } = {}) {}
  async ensureCollection(profile: EmbeddingProfile): Promise<string> {
    const derivedName = collectionForProfile(profile, this.options.prefix ?? 'knowledge');
    if (profile.collectionName && profile.collectionName !== derivedName) {
      throw new Error(`Embedding profile collection mismatch: expected ${derivedName}, received ${profile.collectionName}`);
    }
    this.collectionName = profile.collectionName || derivedName;
    const existing = await this.client.getCollections();
    if (!existing.collections?.some((x: any) => x.name === this.collectionName)) {
      await this.client.createCollection(this.collectionName, { vectors: { size: profile.dimension, distance: 'Cosine' } });
      await this.client.createPayloadIndex(this.collectionName, 'tenant_id', { field_schema: { type: 'keyword', is_tenant: true } });
      await this.client.createPayloadIndex(this.collectionName, 'kb_id', { field_schema: 'keyword' });
      await this.client.createPayloadIndex(this.collectionName, 'document_id', { field_schema: 'keyword' });
    }
    return this.collectionName;
  }
  async upsert(points: QdrantPoint[]): Promise<void> { await this.client.upsert(this.collectionName, { wait: true, points }); }
  async search(vector: number[], tenantId: string, kbIds: string[], limit: number): Promise<VectorHit[]> {
    const rows = await this.client.search(this.collectionName, { vector, limit, filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }, { key: 'kb_id', match: { any: kbIds } }] }, with_payload: true });
    return rows.map((r: any) => ({ chunkId: String(r.payload?.chunk_id ?? r.id), score: r.score, sourceChunkIds: r.payload?.source_chunk_ids }));
  }
  async deleteByDocument(tenantId: string, kbId: string, documentId: string): Promise<void> {
    await this.client.delete(this.collectionName, { wait: true, filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }, { key: 'kb_id', match: { value: kbId } }, { key: 'document_id', match: { value: documentId } }] } });
  }
}
