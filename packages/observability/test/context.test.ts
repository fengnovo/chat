import assert from 'node:assert/strict';
import test from 'node:test';
import { trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { injectObservabilityContext, extractObservabilityContext } from '../src/context.js';
import { createObservabilityResource } from '../src/resource.js';
import { loadObservabilityConfig } from '../src/config.js';

test('W3C context roundtrips across a transport and ignores invalid parents', () => {
  const carrier = { traceparent: '00-12345678901234567890123456789012-1234567890123456-01', tracestate: 'vendor=value', requestId: 'request-1' };
  const extracted = extractObservabilityContext(carrier);
  assert.equal(trace.getSpanContext(extracted)?.isRemote, true);
  assert.deepEqual(injectObservabilityContext(extracted, carrier.requestId), carrier);
  assert.equal(trace.getSpanContext(extractObservabilityContext({ traceparent: 'bad' }, ROOT_CONTEXT)), undefined);
  assert.deepEqual(injectObservabilityContext(ROOT_CONTEXT), {});
});

test('resources identify deployments and instances without tenant or run dimensions', () => {
  const config = loadObservabilityConfig({}, { serviceName: 'worker', serviceVersion: '1' });
  const resource = createObservabilityResource(config, { GIT_SHA: 'abc1234', OTEL_RESOURCE_ATTRIBUTES: 'user.id=secret,tenant.id=secret,run.id=secret' });
  assert.equal(resource.attributes['service.name'], 'worker');
  assert.equal(resource.attributes['service.version'], '1');
  assert.equal(resource.attributes['deployment.environment.name'], 'development');
  assert.equal(resource.attributes['vcs.ref.head.revision'], 'abc1234');
  assert.ok(resource.attributes['service.instance.id']);
  assert.ok(!JSON.stringify(resource.attributes).includes('secret'));
});
