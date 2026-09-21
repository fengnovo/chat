import { parseDocument, isSupportedMime } from '../parser/index.js';
import { splitIntoChunks, stableChunkId } from '../chunker/split.js';
import { assertDocumentBytes } from './hash.js';

/**
 * 把挂在本文档下的图片 caption 转成合成 chunk，参与向量召回。
 * 用 9000+ 序数避开 md 文本 chunk；heading 形如 "图片 · <filename>"，方便 UI 区分。
 * imageRefs 用 kb 级路径（rel_path），与文本 chunk 走同一套 listAssetsByRefs 反查逻辑。
 */
function buildImageCaptionChunks(documentId: string, assets: Array<{ id: string; rel_path: string; name: string; caption: string }>): Array<{ ordinal: number; text: string; start: number; end: number; headingPath: string[]; imageRefs: Array<{ path: string; alt: string }> }> {
  return assets
    .filter((asset) => typeof asset.caption === 'string' && asset.caption.trim().length > 0)
    .map((asset, index) => {
      const caption = asset.caption.trim();
      const alt = caption.length > 80 ? `${caption.slice(0, 77)}…` : caption;
      return {
        ordinal: 9000 + index,
        text: `图片描述：${caption}`,
        start: Number.MAX_SAFE_INTEGER - index, // caption chunk 不在 [start, end) 区间重叠里，避免 graph extract 误并入
        end: Number.MAX_SAFE_INTEGER,
        headingPath: ['图片', asset.name],
        imageRefs: [{ path: asset.rel_path, alt }],
      };
    });
}

export class IndexPipeline {
  constructor(private readonly deps: any) {}
  async run(job: any): Promise<void> {
    const d = this.deps;
    try {
      const guard = async (stage: string) => { const ok = await d.repository.markIndexStage(job.tenantId, job.id, job.leaseToken ?? '', stage); if (ok === false) throw new Error('Index job lease lost'); };
      await guard('parsing');
      const bytes = await d.download(job.objectKey);
      assertDocumentBytes(bytes, job.contentHash, job.sizeBytes, job.mime);
      if (!isSupportedMime(job.mime)) throw new Error(`Unsupported MIME type: ${job.mime}`);
      const parsed = await parseDocument(bytes, job.mime);
      await guard('chunking');
      const textChunks = splitIntoChunks(parsed, { size: job.chunkSize, overlap: job.chunkOverlap });
      // 拉本 doc 已 ready 的图片 caption，合并为同一份 chunk 数组参与 embedding。
      // caption chunk 是合成出来的，仍走 stableChunkId(documentId, ordinal, text) 与 replaceDocumentChunks 落库。
      const captionAssets = typeof d.repository.listDocumentAssetsForIndexing === 'function'
        ? await d.repository.listDocumentAssetsForIndexing(job.tenantId, job.kbId, job.documentId, { captionStatus: 'ready' })
        : [];
      const captionChunks = buildImageCaptionChunks(job.documentId, captionAssets ?? []);
      const chunks = [...textChunks, ...captionChunks];
      const vectors = await d.embedder.embedTexts(chunks.map((c: any) => c.text));
      await guard('persisting');
      await d.vectorStore.ensureCollection(d.embedder.profile);
      await d.vectorStore.deleteByDocument(job.tenantId, job.kbId, job.documentId);
      const points = chunks.map((c: any, i: number) => ({ id: stableChunkId(job.documentId, c.ordinal, c.text), vector: vectors[i], payload: { tenant_id: job.tenantId, kb_id: job.kbId, document_id: job.documentId, chunk_id: stableChunkId(job.documentId, c.ordinal, c.text), image_refs: c.imageRefs ?? [], chunk_source: c.ordinal >= 9000 ? 'image_caption' : 'document_text' } }));
      await d.vectorStore.upsert(points);
      if (d.repository.replaceDocumentChunks) await d.repository.replaceDocumentChunks(job.tenantId, job.kbId, job.documentId, chunks.map((c: any, i: number) => ({ id: points[i]!.id, ordinal: c.ordinal, text: c.text, heading: c.headingPath?.join(' / '), vectorPointId: points[i]!.id, metadata: { headingPath: c.headingPath, imageRefs: c.imageRefs ?? [], source: c.ordinal >= 9000 ? 'image_caption' : 'document_text' }, tokenCount: c.text.length })));
      const graph: { entities: any[]; relationships: any[] } = { entities: [], relationships: [] };
      // 图谱抽取只跑文本 chunk；caption chunk 是从图片里来的，模型看不到，再抽会重复同一组实体并打乱权重。
      for (const chunk of textChunks) {
        const chunkId = stableChunkId(job.documentId, chunk.ordinal, chunk.text);
        const extracted = await d.extract(chunk.text);
        graph.entities.push(...(extracted.entities ?? []).map((entity: any) => ({ ...entity, chunkIds: [...(entity.chunkIds ?? []), chunkId] })));
        graph.relationships.push(...(extracted.relationships ?? []).map((relationship: any) => ({ ...relationship, chunkIds: [...(relationship.chunkIds ?? []), chunkId] })));
      }
      await d.repository.replaceDocumentGraph(job.tenantId, job.kbId, job.documentId, graph);
      const completed = await d.repository.completeIndexJob(job.tenantId, job.id, job.leaseToken ?? '', chunks.length);
      if (completed === false) throw new Error('Index job lease lost');
    } catch (error) { await d.repository.failIndexJob(job.tenantId, job.id, job.leaseToken ?? '', error); throw error; }
  }
}
