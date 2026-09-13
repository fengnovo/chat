import type { CandidateEvidence, GraphTraversal, VectorHit } from '../types.js';
export function mergeCandidates(vectorHits: VectorHit[], graphResult: GraphTraversal, limits: { maxCandidates: number }): CandidateEvidence[] {
  if (!Number.isFinite(limits.maxCandidates) || !Number.isInteger(limits.maxCandidates) || limits.maxCandidates < 0) throw new Error('Invalid candidate limit');
  const byId = new Map<string, CandidateEvidence>();
  for (const hit of vectorHits) byId.set(hit.chunkId, { chunkId: hit.chunkId, score: hit.score, via: 'vector', sourceChunkIds: hit.sourceChunkIds ?? [hit.chunkId] });
  for (const relation of graphResult.relations) for (const chunkId of relation.sourceChunkIds) {
    const existing = byId.get(chunkId);
    if (existing) {
      existing.via = 'vector+graph';
      existing.sourceChunkIds = [...new Set([...existing.sourceChunkIds, ...relation.sourceChunkIds])];
    }
    else byId.set(chunkId, { chunkId, score: 0, via: 'graph', sourceChunkIds: [...relation.sourceChunkIds] });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, limits.maxCandidates);
}
