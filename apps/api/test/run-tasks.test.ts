import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes.js';

test('task inspection passes the authenticated owner and returns durable children', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const runId = '00000000-0000-4000-8000-000000000001';
  const auth = {tenantId:'tenant',userId:'owner',roles:['member']};
  const tasks = {runId,status:'running',executionState:'waiting',owner:{workerId:null,leaseEpoch:2,leaseExpiresAt:null,recoveryAttempts:1},waitingReason:{kind:'tool-approval'},children:[{id:'child',status:'cancelled'}]};
  app.addHook('preHandler',async(request)=>{request.auth=auth;});
  await registerRoutes(app,{config:{},repository:{listRunTasks:async(context:unknown,id:string)=>{
    assert.deepEqual(context,auth);
    return id===runId ? tasks:null;
  }}} as never);
  assert.deepEqual((await app.inject(`/api/agent/runs/${runId}/tasks`)).json(),tasks);
  assert.equal((await app.inject('/api/agent/runs/00000000-0000-4000-8000-000000000002/tasks')).statusCode,404);
});
