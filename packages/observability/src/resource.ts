import { randomUUID } from 'node:crypto';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type { ObservabilityConfig } from './config.js';

const instanceId = randomUUID();

/** 使用显式允许列表；绝不合并任意 OTEL_RESOURCE_ATTRIBUTES 或请求数据。 */
export function createObservabilityResource(config: ObservabilityConfig, env: NodeJS.ProcessEnv = process.env): Resource {
  const revision = env.GIT_SHA ?? env.GIT_COMMIT_SHA ?? env.SOURCE_VERSION;
  return resourceFromAttributes({
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    'deployment.environment.name': config.environment,
    'service.instance.id': instanceId,
    'vcs.ref.head.revision': revision && /^[a-f\d]{7,64}$/i.test(revision) ? revision : 'unknown',
  });
}
