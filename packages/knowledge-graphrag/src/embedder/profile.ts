import { createHash } from 'node:crypto';

import type { EmbeddingProfile } from '../types.js';

export interface EmbeddingProfileInput {
  key: string;
  model: string;
  dimension: number;
  collectionPrefix?: string;
}

export function collectionForProfile(
  profile: Pick<EmbeddingProfile, 'key' | 'model' | 'dimension'>,
  prefix = 'knowledge',
): string {
  const digest = createHash('sha256')
    .update(`${profile.key}\0${profile.model}`)
    .digest('hex')
    .slice(0, 16);
  return `${prefix}_${digest}_${profile.dimension}`;
}

export function buildEmbeddingProfile(input: EmbeddingProfileInput): EmbeddingProfile {
  const key = input.key.trim();
  const model = input.model.trim();
  const collectionPrefix = input.collectionPrefix?.trim() || 'knowledge';
  if (!key) throw new Error('Embedding profile key is required');
  if (!model) throw new Error('Embedding model is required');
  if (!Number.isInteger(input.dimension) || input.dimension <= 0) {
    throw new Error('Embedding dimension must be a positive integer');
  }
  const profile = { key, model, dimension: input.dimension };
  return {
    ...profile,
    collectionName: collectionForProfile(profile, collectionPrefix),
  };
}
