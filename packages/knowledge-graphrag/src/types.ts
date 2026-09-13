export interface ParsedSection { level: number; title: string }
export interface ParsedDocument { text: string; mime: 'text/plain' | 'text/markdown'; sections: ParsedSection[] }
export interface TextChunk { ordinal: number; text: string; headingPath: string[] }
export interface GraphEntity { name: string; key?: string }
export interface GraphRelationship { source: string; target: string; type: string }
export interface GraphExtraction { entities: GraphEntity[]; relationships: GraphRelationship[] }
export interface GraphLimits { maxHops: number; maxFanout: number; maxRelations: number }
export interface GraphRelation { id: string; source: string; target: string; type: string; sourceChunkIds: string[] }
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
