import { randomUUID } from 'node:crypto';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type { ObservabilityConfig } from './config.js';

const instanceId = randomUUID();

/** Explicit allowlist: never merge arbitrary OTEL_RESOURCE_ATTRIBUTES or request data. */
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
