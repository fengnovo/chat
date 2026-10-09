import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerRoutes } from '../src/routes.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { signSessionToken } from '../src/auth.js';

async function fixture(t: test.TestContext, user = 'owner') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat-preview-test-'));
  const workspace = path.join(root, 'workspace-id', 'user-data', 'workspace');
  await mkdir(path.join(workspace, 'dist'), { recursive: true });
  await writeFile(path.join(workspace, 'dist', 'index.html'), '<h1>private preview</h1>');
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.auth = { tenantId: 'tenant', userId: user, roles: ['member'] }; });
  await registerRoutes(app, { config: loadConfig({ NODE_ENV: 'test', SANDBOX_SESSIONS_ROOT: root, AUTH_JWT_SECRET: 'test-secret-test-secret-test-secret-123' }), repository: {
    getSession: async (auth: {userId: string}, id: string) => auth.userId === 'owner' && id === '00000000-0000-4000-8000-000000000001' ? {id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace-id'} : null,
    getSessionByExternalKey: async (auth: {userId: string}, id: string) => auth.userId === 'owner' && id === 'external' ? {id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace-id'} : null,
    getWorkspaceSandboxForWorker: async () => ({workspaceId: 'workspace-id'}),
    getWorkspaceIdByExternalKey: async () => 'workspace-id',
  }} as never);
  t.after(async () => { await app.close(); await rm(root, {recursive: true, force: true}); });
  return {app, root, workspace};
}

test('preview refuses a different user even with an allowed Referer', async (t) => {
  const {app} = await fixture(t, 'other-user');
  const response = await app.inject({ url: '/api/agent/sessions/00000000-0000-4000-8000-000000000001/preview/', headers: {referer: 'http://localhost:8000/'} });
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.includes('private preview'), false);
});
test('authenticated HTML preview redirects to a scoped URL so isolated frames can load assets', async (t) => {
  const {app} = await fixture(t);
  for (const id of ['00000000-0000-4000-8000-000000000001', 'external']) {
    const redirected = await app.inject(`/api/agent/sessions/${id}/preview/`);
    assert.equal(redirected.statusCode,302);
    const response = await app.inject(redirected.headers.location!);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /private preview/);
    assert.match(response.headers['content-security-policy'] ?? '', /sandbox/);
  }
});
test('preview refuses symlink files and symlink preview roots', async (t) => {
  const {app, root, workspace} = await fixture(t);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'PRIVATE_OUTSIDE');
  await symlink(outside, path.join(workspace, 'dist', 'linked.txt'));
  const response = await app.inject({url: '/api/agent/sessions/00000000-0000-4000-8000-000000000001/preview/linked.txt', headers: {referer: 'http://localhost:8000/'}});
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.includes('PRIVATE_OUTSIDE'), false);
  await rm(path.join(workspace, 'dist'), {recursive: true});
  await mkdir(path.join(root, 'outside-dir'));
  await writeFile(path.join(root, 'outside-dir', 'index.html'), 'PRIVATE_OUTSIDE');
  await symlink(path.join(root, 'outside-dir'), path.join(workspace, 'dist'));
  const linkedRoot = await app.inject({url: '/api/agent/sessions/00000000-0000-4000-8000-000000000001/preview/', headers: {referer: 'http://localhost:8000/'}});
  assert.notEqual(linkedRoot.statusCode, 200);
});
test('preview capability is limited to one session and uses an isolated URL', async (t) => {
  const {app} = await fixture(t);
  const response = await app.inject({method: 'POST', url: '/api/agent/sessions/external/preview-token'});
  assert.equal(response.statusCode, 200);
  const {url} = response.json();
  assert.match(url, /^\/api\/agent\/sessions\/00000000-0000-4000-8000-000000000001\/preview-cap\//);
  const opened = await app.inject(url);
  assert.equal(opened.statusCode, 200);
  const wrong = await app.inject(url.replace('/00000000-0000-4000-8000-000000000001/', '/other/'));
  assert.notEqual(wrong.statusCode, 200);
});

test('full API authentication has no anonymous preview or rebuild bypass', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat-preview-auth-'));
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const tenantId = '00000000-0000-4000-8000-000000000002';
  const userId = '00000000-0000-4000-8000-000000000003';
  await mkdir(path.join(root,'workspace','user-data','workspace','dist'),{recursive:true});
  await writeFile(path.join(root,'workspace','user-data','workspace','dist','index.html'),'private preview');
  await writeFile(path.join(root,'workspace','user-data','workspace','dist','app.js'),'document.body.textContent = "rendered";');
  const config = loadConfig({NODE_ENV:'test',AUTH_MODE:'password',CAPTION_ENABLED:'false',SANDBOX_SESSIONS_ROOT:root,AUTH_JWT_SECRET:'auth-test-secret-00000000000000000000'});
  const queue = {close:async()=>{}};
  const app = await buildApp({config, repository: {
    getMembershipRole:async()=> 'member', ensureIdentity:async()=>{},
    requeueStaleDispatches:async()=>0,claimDispatches:async()=>[],
    getSession:async(auth: {userId:string},id:string)=>auth.userId===userId && id===sessionId ? {id:sessionId}:null,
    getSessionByExternalKey:async()=>null, getWorkspaceSandboxForWorker:async()=>({workspaceId:'workspace'}),
  } as never,queue:queue as never,knowledgeQueue:queue as never,memoryIndexQueue:queue as never,
  publisher:{quit:async()=>{},eval:async()=>[1,1000]} as never,
  knowledgeRepository:{} as never, artifacts:{ensureBucket:async()=>{},destroy(){}} as never});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  for (const [method, suffix] of [['GET','preview/'],['POST','preview-token'],['POST','rebuild']] as const) {
    const response = await app.inject({method,url:`/api/agent/sessions/${sessionId}/${suffix}`,headers:{referer:'http://localhost:8000/'}});
    assert.equal(response.statusCode,401);
  }
  const token = await signSessionToken(config,{tenantId,userId,role:'member'});
  const previewEntry = await app.inject({url:`/api/agent/sessions/${sessionId}/preview/`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(previewEntry.statusCode,302);
  assert.equal((await app.inject(previewEntry.headers.location!)).statusCode,200);
  const issued = await app.inject({method:'POST',url:`/api/agent/sessions/${sessionId}/preview-token`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(issued.statusCode,200);
  const capabilityUrl = issued.json().url as string;
  const opened = await app.inject(capabilityUrl);
  assert.equal(opened.statusCode,200);
  assert.match(opened.body,/private preview/);
  const moduleAsset = await app.inject({url: `${capabilityUrl}app.js`, headers: {origin: 'null'}});
  assert.equal(moduleAsset.statusCode, 200);
  assert.equal(moduleAsset.headers['access-control-allow-origin'], '*', 'opaque sandbox origins must be able to import capability-protected modules');
  assert.equal(moduleAsset.headers['access-control-allow-credentials'], undefined);
  assert.match(moduleAsset.headers['content-security-policy'] ?? '', /sandbox/);
  const privateAsset = await app.inject({url: `/api/agent/sessions/${sessionId}/preview/app.js`, headers: {origin: 'null'}});
  assert.equal(privateAsset.statusCode, 401);
  assert.notEqual(privateAsset.headers['access-control-allow-origin'], '*');
  const capToken = capabilityUrl.split('/preview-cap/')[1]!.split('/')[0]!;
  assert.equal((await app.inject({url:'/api/agent/sessions',headers:{authorization:`Bearer ${capToken}`}})).statusCode,401);
});
