import { createHash } from 'node:crypto';
import type { EmbeddingProfile, VectorHit } from '../types.js';

export interface QdrantPoint { id: string; vector: number[]; payload: Record<string, unknown> }
export interface QdrantClientLike { getCollections(): Promise<any>; createCollection(name: string, config: any): Promise<any>; createPayloadIndex(name: string, field: string, config: any): Promise<any>; upsert(name: string, body: any): Promise<any>; search(name: string, body: any): Promise<any[]>; delete(name: string, body: any): Promise<any> }

export function collectionForProfile(profile: EmbeddingProfile, prefix = 'knowledge'): string {
  const digest = createHash('sha256').update(`${profile.key}\0${profile.model}`).digest('hex').slice(0, 16);
  return `${prefix}_${digest}_${profile.dimension}`;
}

export class QdrantChunkStore {
  private collectionName = '';
  constructor(private readonly client: QdrantClientLike, private readonly options: { prefix?: string } = {}) {}
  async ensureCollection(profile: EmbeddingProfile): Promise<string> {
    this.collectionName = collectionForProfile(profile, this.options.prefix ?? 'knowledge');
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

