import { parseTextDocument } from '../parser/text.js';
import { splitIntoChunks, stableChunkId } from '../chunker/split.js';
import { assertDocumentBytes } from './hash.js';

export class IndexPipeline {
  constructor(private readonly deps: any) {}
  async run(job: any): Promise<void> {
    const d = this.deps;
    try {
      await d.repository.markIndexStage(job.tenantId, job.id, job.leaseToken ?? '', 'parsing');
      const bytes = await d.download(job.objectKey);
      assertDocumentBytes(bytes, job.contentHash, job.sizeBytes, job.mime);
      const parsed = parseTextDocument(bytes, job.mime);
      await d.repository.markIndexStage(job.tenantId, job.id, job.leaseToken ?? '', 'chunking');
      const chunks = splitIntoChunks(parsed, { size: job.chunkSize, overlap: job.chunkOverlap });
      const vectors = await d.embedder.embedTexts(chunks.map((c: any) => c.text));
      await d.vectorStore.ensureCollection(d.embedder.profile);
      await d.vectorStore.deleteByDocument(job.tenantId, job.kbId, job.documentId);
      const points = chunks.map((c: any, i: number) => ({ id: stableChunkId(job.documentId, c.ordinal, c.text), vector: vectors[i], payload: { tenant_id: job.tenantId, kb_id: job.kbId, document_id: job.documentId, chunk_id: stableChunkId(job.documentId, c.ordinal, c.text) } }));
      await d.vectorStore.upsert(points);
      if (d.repository.replaceDocumentChunks) await d.repository.replaceDocumentChunks(job.tenantId, job.kbId, job.documentId, chunks.map((c: any, i: number) => ({ id: points[i]!.id, ordinal: c.ordinal, text: c.text, heading: c.headingPath?.join(' / '), vectorPointId: points[i]!.id, metadata: { headingPath: c.headingPath }, tokenCount: c.text.length })));
      const graph: { entities: any[]; relationships: any[] } = { entities: [], relationships: [] };
      for (const chunk of chunks) {
        const chunkId = stableChunkId(job.documentId, chunk.ordinal, chunk.text);
        const extracted = await d.extract(chunk.text);
        graph.entities.push(...(extracted.entities ?? []).map((entity: any) => ({ ...entity, chunkIds: [...(entity.chunkIds ?? []), chunkId] })));
        graph.relationships.push(...(extracted.relationships ?? []).map((relationship: any) => ({ ...relationship, chunkIds: [...(relationship.chunkIds ?? []), chunkId] })));
      }
      await d.repository.replaceDocumentGraph(job.tenantId, job.kbId, job.documentId, graph);
      await d.repository.completeIndexJob(job.tenantId, job.id, job.leaseToken ?? '', chunks.length);
    } catch (error) { await d.repository.failIndexJob(job.tenantId, job.id, job.leaseToken ?? '', error); throw error; }
  }
}
