import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '@repo/contracts';
import type { ApiConfig } from './config.js';

const developmentSecret = randomBytes(32).toString('hex');
const TTL_SECONDS = 15 * 60;
function secret(config: ApiConfig): string {
  const value = config.PREVIEW_TOKEN_SECRET ?? config.AUTH_JWT_SECRET;
  if (value) return value;
  if (config.NODE_ENV === 'production') throw new Error('PREVIEW_TOKEN_SECRET is required for capability previews');
  return developmentSecret;
}
function signature(payload: string, config: ApiConfig) {
  return createHmac('sha256', secret(config)).update(`preview:v1:${payload}`).digest();
}
export function issuePreviewAccess(config: ApiConfig, auth: AuthContext, sessionId: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({scope: 'preview', tenantId: auth.tenantId, userId: auth.userId, sessionId, expires: Math.floor(now / 1000) + TTL_SECONDS})).toString('base64url');
  return `${payload}.${signature(payload, config).toString('base64url')}`;
}
export function verifyPreviewAccess(config: ApiConfig, token: string, sessionId: string, now = Date.now()): AuthContext | null {
  try {
    if (token.length > 2048) return null;
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra) return null;
    const actual = Buffer.from(mac, 'base64url');
    const expected = signature(payload, config);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (value.scope !== 'preview' || value.sessionId !== sessionId || typeof value.tenantId !== 'string' || typeof value.userId !== 'string' || !Number.isSafeInteger(value.expires) || value.expires <= Math.floor(now / 1000)) return null;
    return {tenantId: value.tenantId, userId: value.userId, roles: []};
  } catch { return null; }
}
export function previewCapabilityPath(pathname: string): {sessionId: string; token: string} | null {
  const match = /^\/api\/agent\/sessions\/([^/]+)\/preview-cap\/([^/]+)(?:\/.*)?$/.exec(pathname);
  if (!match) return null;
  try { return {sessionId: decodeURIComponent(match[1]!), token: match[2]!}; }
  catch { return null; }
}
