import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { S3ArtifactStore } from '@repo/artifacts';
import { type AuthContext, RUN_QUEUE_NAME } from '@repo/contracts';
import type { AgentRepository } from '@repo/db';
import { ForbiddenKnowledgeError, RepositoryConflictError } from '@repo/db';
import { Queue } from 'bullmq';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';

import { registerAdminRoutes } from './admin-routes.js';
import { AuthenticationError, ForbiddenError, createAuthenticator } from './auth.js';
import { registerAuthRoutes } from './auth-routes.js';
import type { ApiConfig } from './config.js';
import { RunOutboxDispatcher } from './outbox.js';
import { registerRoutes } from './routes.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { StreamSubscriptionHub } from './stream-subscriptions.js';
import { loadObservabilityConfig, startObservability, redactTelemetryValue } from '@repo/observability';
import { apiFastifyOptions, createApiObservability, registerApiObservabilityHooks, type ApiObservability } from './observability.js';

interface BuildAppOptions {
  config: ApiConfig;
  repository: AgentRepository;
  publisher?: Redis;
  queue?: Queue;
  knowledgeQueue?: Queue;
  knowledgeRepository: import('./types.js').KnowledgeRepositoryApi;
  artifacts?: S3ArtifactStore;
  observability?: ApiObservability;
}

export async function buildApp(options: BuildAppOptions) {
  const observability = options.observability ?? createApiObservability(
    await startObservability(loadObservabilityConfig({ OTEL_ENABLED: 'false' }, {
      serviceName: 'agent-api', serviceVersion: options.config.API_VERSION,
    })),
    { enabled: false, serviceVersion: options.config.API_VERSION, exporter: 'disabled' },
  );
  const app = Fastify({
    ...apiFastifyOptions(options.config),
    logger: true,
    disableRequestLogging: true,
    bodyLimit: Math.max(1_048_576, options.config.PROJECT_UPLOAD_MAX_BYTES * 2),
  });
  registerApiObservabilityHooks(app, observability);
  const authenticate = createAuthenticator(options.config, {
    loadMembership: (tenantId, userId) =>
      options.repository.getMembershipRole(tenantId, userId),
  });
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
  const knowledgeQueueConnection = options.knowledgeQueue
    ? null
    : new Redis(options.config.REDIS_URL, { maxRetriesPerRequest: null });
  const knowledgeQueue =
    options.knowledgeQueue ??
    new Queue('knowledge-index', { connection: knowledgeQueueConnection! });
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
    queueName: RUN_QUEUE_NAME,
    telemetry: {
      tracer: observability.runtime.tracer,
      metrics: observability.metrics,
    },
    pollIntervalMs: options.config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: options.config.OUTBOX_BATCH_SIZE,
    leaseMs: options.config.OUTBOX_LEASE_MS,
    reconcileIntervalMs: options.config.OUTBOX_RECONCILE_INTERVAL_MS,
    staleAfterMs: options.config.OUTBOX_STALE_AFTER_MS,
  });
  const streamSubscriptions = new StreamSubscriptionHub(
    () =>
      new Redis(options.config.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
      }),
  );

  await app.register(cors, {
    origin: options.config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-agent-run-id', 'x-request-id'],
  });
  await app.register(cookie);

  const PUBLIC_PATHS = new Set([
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/logout',
  ]);
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url;
    if (request.url.startsWith('/health/')) return;
    if (PUBLIC_PATHS.has(pathname)) {
      // 登录与自助注册都是匿名入口，共用同一 IP 限流桶，防撞库与批量注册。
      if (pathname === '/api/auth/login' || pathname === '/api/auth/register') {
        const [count] = (await publisher.eval(
          `local current = redis.call('INCR', KEYS[1])
           if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
           return {current, redis.call('PTTL', KEYS[1])}`,
          1,
          `rate:login:${request.ip}`,
          options.config.RATE_LIMIT_WINDOW_MS,
        )) as [number, number];
        if (count > options.config.RATE_LIMIT_REQUESTS) {
          return reply.code(429).send({ error: 'rate_limit_exceeded' });
        }
      }
      return;
    }
    request.auth = await authenticate({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
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
    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ error: 'forbidden', message: error.message });
    }
    if (error instanceof ForbiddenKnowledgeError) {
      return reply
        .code(403)
        .send({ error: 'knowledge_base_permission_required', message: error.message });
    }
    if (error instanceof RepositoryConflictError) {
      return reply.code(409).send({ error: error.code });
    }
    request.log.error({ error: redactTelemetryValue(error) }, 'request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });

  await registerRoutes(app, {
    config: options.config,
    repository: options.repository,
    queue,
    publisher,
    artifacts,
    outbox,
    streamSubscriptions,
    knowledgeQueue,
    observability,
  });
  await registerKnowledgeRoutes(app, {
    config: options.config,
    repository: options.knowledgeRepository,
    knowledgeQueue,
    artifacts,
  });
  registerAuthRoutes(app, {
    config: options.config,
    repository: options.repository,
  });
  registerAdminRoutes(app, {
    repository: options.repository,
    artifacts,
  });

  app.addHook('onReady', async () => outbox.start());

  app.addHook('onClose', async () => {
    await outbox.stop();
    await streamSubscriptions.closeAll();
    await queue.close();
    await knowledgeQueue.close();
    await queueConnection?.quit();
    await knowledgeQueueConnection?.quit();
    await publisher.quit();
    artifacts.destroy();
  });

  return app;
}

export type { AuthContext };
