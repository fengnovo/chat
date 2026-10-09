import assert from 'node:assert/strict';
import test from 'node:test';
import { issuePreviewAccess, verifyPreviewAccess, previewCapabilityPath } from '../src/preview-access.js';
import { loadConfig } from '../src/config.js';

test('preview capabilities expire, reject tampering, and only authorize their session', () => {
  const config = loadConfig({NODE_ENV:'test', PREVIEW_TOKEN_SECRET:'preview-secret-0000000000000000000000'});
  const auth = {tenantId:'tenant',userId:'owner',roles:['member']};
  const token = issuePreviewAccess(config, auth, 'session', 1_000);
  assert.deepEqual(verifyPreviewAccess(config,token,'session',1_000), {...auth,roles:[]});
  assert.equal(verifyPreviewAccess(config,token,'other',1_000),null);
  assert.equal(verifyPreviewAccess(config,token,'session',901_000),null);
  assert.equal(verifyPreviewAccess(config,`x${token}`,'session',1_000),null);
  assert.equal(verifyPreviewAccess(config,token,'session',1_000)?.roles.includes('admin'),false);
});
test('only the dedicated preview capability route accepts a token', () => {
  assert.deepEqual(previewCapabilityPath('/api/agent/sessions/a/preview-cap/token/assets/app.js'),{sessionId:'a',token:'token'});
  for (const path of ['/api/agent/sessions/a/preview-token','/api/agent/runs/preview-cap/token','/api/agent/sessions/a/rebuild','/api/agent/sessions/%/preview-cap/token']) assert.equal(previewCapabilityPath(path),null);
});
test('production OIDC preview issuance requires a configured secret', () => {
  const config = loadConfig({NODE_ENV:'test',AUTH_MODE:'oidc',OIDC_ISSUER:'https://identity.example.test',OIDC_AUDIENCE:'chat',OIDC_JWKS_URL:'https://identity.example.test/jwks',AUTH_JWT_SECRET:undefined,PREVIEW_TOKEN_SECRET:undefined});
  assert.throws(() => issuePreviewAccess({...config,NODE_ENV:'production'}, {tenantId:'t',userId:'u',roles:[]}, 's'),/PREVIEW_TOKEN_SECRET/);
});
