import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { verifyRunToken } from '../src/run-token.js';

const ids = { tenantId:'00000000-0000-4000-8000-000000000001', userId:'00000000-0000-4000-8000-000000000002', sessionId:'00000000-0000-4000-8000-000000000003', runId:'00000000-0000-4000-8000-000000000004', jti:'00000000-0000-4000-8000-000000000005', kbIds:['00000000-0000-4000-8000-000000000006'] };
const secret = 'test-secret';
async function token(overrides: Record<string, unknown> = {}, exp = Math.floor(Date.now()/1000)+60) {
  const jwt = new SignJWT({ ...ids, ...overrides }).setProtectedHeader({ alg:'HS256' }).setExpirationTime(exp).setIssuedAt().setJti(ids.jti);
  if (!('aud' in overrides)) jwt.setAudience('knowledge-service');
  return jwt.sign(new TextEncoder().encode(secret));
}
test('verifyRunToken validates signature, audience, expiry and claims', async () => {
  const claims = await verifyRunToken(await token(), secret);
  assert.deepEqual(claims.tenantId, ids.tenantId);
  const valid = await token();
  await assert.rejects(() => verifyRunToken(valid, 'wrong'), /401/);
  await assert.rejects(() => token({ aud:'wrong' }).then((t) => verifyRunToken(t, secret)), /401/);
  await assert.rejects(() => token({}, Math.floor(Date.now()/1000)-1).then((t) => verifyRunToken(t, secret)), /401/);
  await assert.rejects(() => token({ tenantId:'bad' }).then((t) => verifyRunToken(t, secret)), /401/);
});
