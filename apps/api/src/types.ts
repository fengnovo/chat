import type { S3ArtifactStore } from '@repo/artifacts';
import type { AuthContext } from '@repo/contracts';
import type { AgentRepository } from '@repo/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { ApiConfig } from './config.js';
import type { RunOutboxDispatcher } from './outbox.js';
import type { StreamSubscriptionHub } from './stream-subscriptions.js';

export interface ApiServices {
  config: ApiConfig;
  repository: AgentRepository;
  queue: Queue;
  publisher: Redis;
  artifacts: S3ArtifactStore;
  outbox: RunOutboxDispatcher;
  streamSubscriptions: StreamSubscriptionHub;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}
