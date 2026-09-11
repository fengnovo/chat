import cors from '@fastify/cors';
import { S3ArtifactStore } from '@repo/artifacts';
import { type AuthContext, RUN_QUEUE_NAME } from '@repo/contracts';
import type { AgentRepository } from '@repo/db';
import { Queue } from 'bullmq';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';

import { AuthenticationError, createAuthenticator } from './auth.js';
import type { ApiConfig } from './config.js';
import { RunOutboxDispatcher } from './outbox.js';
import { registerRoutes } from './routes.js';

interface BuildAppOptions {
  config: ApiConfig;
  repository: AgentRepository;
  publisher?: Redis;
  queue?: Queue;
  artifacts?: S3ArtifactStore;
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({ logger: true });
  const publisher =
    options.publisher ??
    new Redis(options.config.REDIS_URL, { maxRetriesPerRequest: null });
  const queueConnection = options.queue
    ? null
    : new Redis(options.config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue =
    options.queue ??
    new Queue(RUN_QUEUE_NAME, {
      connection: queueConnection!,
    });
  const authenticate = createAuthenticator(options.config);
  const artifacts =
    options.artifacts ??
    new S3ArtifactStore({
      endpoint: options.config.S3_ENDPOINT,
      ...(options.config.S3_PUBLIC_ENDPOINT
        ? { publicEndpoint: options.config.S3_PUBLIC_ENDPOINT }
        : {}),
      region: options.config.S3_REGION,
      bucket: options.config.S3_BUCKET,
      accessKey: options.config.S3_ACCESS_KEY,
      secretKey: options.config.S3_SECRET_KEY,
    });
  await artifacts.ensureBucket();
  const outbox = new RunOutboxDispatcher({
    repository: options.repository,
    queue,
    logger: app.log,
    pollIntervalMs: options.config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: options.config.OUTBOX_BATCH_SIZE,
    leaseMs: options.config.OUTBOX_LEASE_MS,
    reconcileIntervalMs: options.config.OUTBOX_RECONCILE_INTERVAL_MS,
    staleAfterMs: options.config.OUTBOX_STALE_AFTER_MS,
  });

  await app.register(cors, {
    origin: options.config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['x-agent-run-id'],
  });

  app.decorateRequest('auth');
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/health/')) return;
    request.auth = await authenticate(request.headers.authorization);
    await options.repository.ensureIdentity(request.auth);
    const rateKey = `rate:api:${request.auth.tenantId}:${request.auth.userId}`;
    const [count, ttl] = (await publisher.eval(
      `local current = redis.call('INCR', KEYS[1])
       if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
       return {current, redis.call('PTTL', KEYS[1])}`,
      1,
      rateKey,
      options.config.RATE_LIMIT_WINDOW_MS,
    )) as [number, number];
    reply.header(
      'x-ratelimit-remaining',
      String(Math.max(0, options.config.RATE_LIMIT_REQUESTS - count)),
    );
    if (count > options.config.RATE_LIMIT_REQUESTS) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(ttl / 1_000))));
      return reply.code(429).send({ error: 'rate_limit_exceeded' });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: error.issues });
    }
    if (error instanceof AuthenticationError) {
      return reply.code(401).send({ error: 'unauthorized', message: error.message });
    }
    request.log.error({ error }, 'request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });

  await registerRoutes(app, {
    config: options.config,
    repository: options.repository,
    queue,
    publisher,
    artifacts,
    outbox,
  });

  app.addHook('onReady', async () => outbox.start());

  app.addHook('onClose', async () => {
    await outbox.stop();
    await queue.close();
    await queueConnection?.quit();
    await publisher.quit();
    artifacts.destroy();
  });

  return app;
}

export type { AuthContext };
