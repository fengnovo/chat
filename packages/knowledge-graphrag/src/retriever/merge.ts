import type { CandidateEvidence, GraphTraversal, VectorHit } from '../types.js';

/**
 * 默认 RRF k 值。k 越大，对低 rank 的平滑越强（即对顶端结果的偏好越弱）。
 * 60 是 Cormack 等人 (2009) 的常用经验值，能在召回与精确之间取得较稳定平衡。
 */
export const DEFAULT_RRF_K = 60;

export interface MergeLimits {
  maxCandidates: number;
  /**
   * RRF 平滑系数。可选，默认 60。
   */
  rrfK?: number;
}

/**
 * 基于 Reciprocal Rank Fusion (RRF) 的向量 / 图谱结果融合：
 *   score = sum( 1 / (k + rank_i + 1) )，其中 rank_i 是该 chunk 在该路召回中的名次（0-based）。
 *
 * - 向量路召回按 VectorHit 数组顺序作为 rank（Qdrant 已按 cosine 倒序返回）。
 * - 图谱路召回按 GraphRelation.hop 升序作为 rank，hop 内再按数组下标递增。
 * - 同时被两条路命中的 chunk 会同时拿到两个 1/(k+r+1) 贡献，自然提升其总分。
 *
 * 该排序与原始 score（向量余弦 / 图谱概率）解耦，因此输出分数落在 (0, 2/(k+1)] 区间。
 */
export function mergeCandidates(
  vectorHits: VectorHit[],
  graphResult: GraphTraversal,
  limits: MergeLimits,
): CandidateEvidence[] {
  if (!Number.isFinite(limits.maxCandidates) || !Number.isInteger(limits.maxCandidates) || limits.maxCandidates < 0) {
    throw new Error('Invalid candidate limit');
  }
  const k = limits.rrfK ?? DEFAULT_RRF_K;

  // 1) 向量路 rank 映射：Qdrant 已经按相似度倒序返回，所以下标就是 rank。
  const vectorRank = new Map<string, number>();
  const seedSourcesByChunk = new Map<string, string[]>();
  vectorHits.forEach((hit, idx) => {
    if (!vectorRank.has(hit.chunkId)) {
      vectorRank.set(hit.chunkId, idx);
      seedSourcesByChunk.set(hit.chunkId, [...(hit.sourceChunkIds ?? [hit.chunkId])]);
    }
  });

  // 2) 图谱路 rank 映射：先按 hop 升序，hop 内按下标递增。
  //    hop=1 的关系更接近种子实体，理应获得更小的 rank（更靠前）。
  const rankedRelations = graphResult.relations
    .map((rel, idx) => ({ rel, idx }))
    .sort((a, b) => a.rel.hop - b.rel.hop || a.idx - b.idx);
  const graphRank = new Map<string, number>();
  const extraSourcesByChunk = new Map<string, string[]>();
  rankedRelations.forEach(({ rel }, rank) => {
    for (const chunkId of rel.sourceChunkIds) {
      if (!graphRank.has(chunkId)) graphRank.set(chunkId, rank);
      const bucket = extraSourcesByChunk.get(chunkId) ?? [];
      for (const sc of rel.sourceChunkIds) {
        if (!bucket.includes(sc)) bucket.push(sc);
      }
      extraSourcesByChunk.set(chunkId, bucket);
    }
  });

  // 3) 聚合每个 chunk 的贡献。RRF 分数越高越相关。
  const allChunkIds = new Set<string>([...vectorRank.keys(), ...graphRank.keys()]);
  const byId = new Map<string, CandidateEvidence>();
  for (const chunkId of allChunkIds) {
    const vRank = vectorRank.get(chunkId);
    const gRank = graphRank.get(chunkId);
    const rrfScore =
      (vRank !== undefined ? 1 / (k + vRank + 1) : 0) +
      (gRank !== undefined ? 1 / (k + gRank + 1) : 0);

    let via: CandidateEvidence['via'];
    if (vRank !== undefined && gRank !== undefined) via = 'vector+graph';
    else if (vRank !== undefined) via = 'vector';
    else via = 'graph';

    const baseSources = seedSourcesByChunk.get(chunkId) ?? [chunkId];
    const extras = (extraSourcesByChunk.get(chunkId) ?? []).filter((sc) => !baseSources.includes(sc));
    byId.set(chunkId, {
      chunkId,
      score: rrfScore,
      via,
      sourceChunkIds: [...baseSources, ...extras],
    });
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, limits.maxCandidates);
}