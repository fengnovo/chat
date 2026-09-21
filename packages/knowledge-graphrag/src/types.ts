export type DocumentMime =
  | 'text/plain'
  | 'text/markdown'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ParsedSection { level: number; title: string }

/** md 中出现的图片引用：相对路径 + alt 文本 + 在原文中的字符 offset。 */
export interface ParsedImageRef {
  /** 相对路径，已去除 ./ 前缀（统一使用 basename 或子目录形式） */
  path: string;
  /** ![alt](path) 的 alt 文本，可为空 */
  alt: string;
  /** 图片引用 `![](...)` 起始 '!' 字符在原文 text 中的字符 offset */
  offset: number;
}

export interface ParsedDocument {
  text: string;
  mime: DocumentMime;
  sections: ParsedSection[];
  /** markdown 文档中收集到的全部图片引用及其 offset。 */
  imageRefs: ParsedImageRef[];
}

/** chunk 上挂的图片引用列表，相对路径形式。 */
export interface ChunkImageRef {
  path: string;
  alt: string;
}

export interface TextChunk {
  ordinal: number;
  text: string;
  /** chunk 对应原文 text 中的 [start, end) 字符区间，用于把图片引用挂到正确的 chunk 上。 */
  start: number;
  end: number;
  headingPath: string[];
  /** 落在本 chunk 字符区间内的 markdown 图片引用。 */
  imageRefs: ChunkImageRef[];
}
export interface GraphEntity { name: string; key?: string }
export interface GraphRelationship { source: string; target: string; type: string }
export interface GraphExtraction { entities: GraphEntity[]; relationships: GraphRelationship[] }
export interface GraphLimits { maxHops: number; maxFanout: number; maxRelations: number }
export interface GraphRelation { id: string; source: string; target: string; type: string; sourceChunkIds: string[]; hop: number }
export interface GraphTraversal { entityKeys: string[]; relations: GraphRelation[]; chunkIds: string[] }
export interface GraphStore {
  addExtraction(documentId: string, chunkId: string, extraction: GraphExtraction): void;
  entityKeysForChunks(chunkIds: Iterable<string>): Set<string>;
  traverse(seedKeys: Iterable<string>, limits: GraphLimits): GraphTraversal;
  removeDocument(documentId: string): void;
}
export interface Embedder { profile: EmbeddingProfile; embedTexts(texts: string[]): Promise<number[][]>; embedQuery(text: string): Promise<number[]> }
export interface EmbeddingProfile { key: string; model: string; dimension: number; collectionName: string }
export interface VectorHit { chunkId: string; score: number; sourceChunkIds?: string[] }
export interface CandidateEvidence { chunkId: string; score: number; via: 'vector' | 'graph' | 'vector+graph'; sourceChunkIds: string[] }
