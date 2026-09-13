import { jwtVerify } from 'jose';
import { knowledgeRunTokenClaimsSchema, type KnowledgeRunTokenClaims } from '@repo/contracts';

export async function verifyRunToken(header: string | undefined, secret: string): Promise<KnowledgeRunTokenClaims> {
  try {
    if (!header) throw new Error('missing bearer token');
    const key = new TextEncoder().encode(secret);
    const raw = header.startsWith('Bearer ') ? header.slice(7) : header;
    const { payload } = await jwtVerify(raw, key, { audience: 'knowledge-service', algorithms: ['HS256'] });
    return knowledgeRunTokenClaimsSchema.parse(payload);
  } catch (error) {
    throw new Error(`401 Unauthorized: ${error instanceof Error ? error.message : String(error)}`);
  }
}
