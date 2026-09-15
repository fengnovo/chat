import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { loadObservabilityConfig, startObservability } from '@repo/observability';

import { createAgentTelemetry, classifyTool, modelFamilyOf } from '../src/agent-telemetry.js';
import { createWorkerObservability } from '../src/observability.js';

process.env.OBSERVABILITY_LOG_LEVEL = 'fatal';

interface FlatPoint {
  name: string;
  attributes: Record<string, string>;
  value: number;
}

async function setupTelemetry() {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const runtime = await startObservability(
    loadObservabilityConfig(
      { OTEL_ENABLED: 'true', OTEL_TRACES_SAMPLER_ARG: '1' },
      { serviceName: 'worker-model-test', serviceVersion: 'test' },
    ),
    { spanExporter, metricExporter },
  );
  const observability = createWorkerObservability(runtime, { serviceVersion: 'test' });
  const collect = async (): Promise<FlatPoint[]> => {
    await runtime.forceFlush();
    const points: FlatPoint[] = [];
    for (const resource of metricExporter.getMetrics()) {
      for (const scope of resource.scopeMetrics) {
        for (const metric of scope.metrics as Array<{
          descriptor: { name: string };
          dataPoints: Array<{ attributes: Record<string, unknown>; value: number }>;
        }>) {
          for (const point of metric.dataPoints) {
            points.push({
              name: metric.descriptor.name,
              attributes: Object.fromEntries(
                Object.entries(point.attributes).map(([key, value]) => [key, String(value)]),
              ),
              value: point.value,
            });
          }
        }
      }
    }
    return points;
  };
  return {
    telemetry: createAgentTelemetry(observability),
    runtime,
    spanExporter,
    collect,
  };
}

test('model calls and tokens carry only normalized low-cardinality labels', async () => {
  const harness = await setupTelemetry();
  harness.telemetry.modelCall({
    provider: 'openai',
    model: 'gpt-4o-2025-05-13',
    outcome: 'success',
    latencyMs: 120,
    retries: 1,
  });
  harness.telemetry.modelTokens({
    provider: 'openai',
    model: 'gpt-4o-2025-05-13',
    inputTokens: 1_000,
    outputTokens: 250,
  });
  // 未知厂商/型号一律归一为 other，型号版本号不得进入 label。
  harness.telemetry.modelCall({
    provider: 'acme-finetune-v42',
    model: 'internal-llm-20260901',
    outcome: 'failure',
    latencyMs: 30,
  });

  const points = await harness.collect();
  const calls = points.filter((point) => point.name === 'model.calls.total');
  assert.ok(
    calls.some(
      (point) =>
        point.attributes.provider === 'openai' &&
        point.attributes.model === 'gpt' &&
        point.attributes.outcome === 'success',
    ),
  );
  assert.ok(
    calls.some(
      (point) =>
        point.attributes.provider === 'other' &&
        point.attributes.model === 'other' &&
        point.attributes.outcome === 'failure',
    ),
  );
  const inputTokens = points.find(
    (point) =>
      point.name === 'model.tokens.input' && point.attributes.provider === 'openai',
  );
  assert.equal(inputTokens?.value, 1_000);
  const outputTokens = points.find(
    (point) =>
      point.name === 'model.tokens.output' && point.attributes.model === 'gpt',
  );
  assert.equal(outputTokens?.value, 250);
  const retries = points.find((point) => point.name === 'model.retries.total');
  assert.equal(retries?.value, 1);

  // 高基数身份字段绝不能出现在任何 metric label 上。
  for (const point of points) {
    assert.equal(point.attributes.run_id, undefined);
    assert.equal(point.attributes.user_id, undefined);
    assert.equal(point.attributes.tenant_id, undefined);
    assert.equal(point.attributes.session_id, undefined);
  }

  await harness.runtime.shutdown();
});

test('tool calls normalize into fixed tool/operation enums', async () => {
  assert.deepEqual(classifyTool('execute'), { tool: 'sandbox', operation: 'execute' });
  assert.deepEqual(classifyTool('write_file'), { tool: 'sandbox', operation: 'execute' });
  assert.deepEqual(classifyTool('graphrag_search'), { tool: 'knowledge', operation: 'search' });
  assert.deepEqual(classifyTool('web_search'), { tool: 'web', operation: 'search' });
  assert.deepEqual(classifyTool('some_custom_mcp_tool'), { tool: 'other', operation: 'other' });
  assert.equal(modelFamilyOf('claude-sonnet-4-5'), 'claude');
  assert.equal(modelFamilyOf('gemini-2.5-pro'), 'gemini');
  assert.equal(modelFamilyOf('qwen-max'), 'qwen');

  const harness = await setupTelemetry();
  harness.telemetry.toolCall({ tool: 'graphrag_search', outcome: 'success', latencyMs: 42 });
  harness.telemetry.toolCall({ tool: 'team_random_mcp_tool', outcome: 'failure', latencyMs: 7 });
  const points = await harness.collect();
  const toolPoints = points.filter((point) => point.name === 'tool.calls.total');
  assert.ok(
    toolPoints.some(
      (point) =>
        point.attributes.tool === 'knowledge' &&
        point.attributes.operation === 'search' &&
        point.attributes.outcome === 'success',
    ),
  );
  assert.ok(
    toolPoints.some(
      (point) =>
        point.attributes.tool === 'other' &&
        point.attributes.operation === 'other' &&
        point.attributes.outcome === 'failure',
    ),
  );
  assert.ok(points.some((point) => point.name === 'tool.call.duration'));
  await harness.runtime.shutdown();
});

test('circuit breaker transitions parse model ids and use finite states', async () => {
  const harness = await setupTelemetry();
  harness.telemetry.circuit({ model: 'openai:gpt-4o', state: 'open' });
  harness.telemetry.circuit({ model: 'openai:gpt-4o', state: 'rejected' });
  harness.telemetry.circuit({ model: 'anthropic:claude-test', state: 'half_open' });
  harness.telemetry.circuit({ model: 'mystery-model', state: 'closed' });

  const points = await harness.collect();
  const circuitPoints = points.filter((point) => point.name === 'model.circuit.total');
  assert.ok(
    circuitPoints.some(
      (point) =>
        point.attributes.provider === 'openai' &&
        point.attributes.model === 'gpt' &&
        point.attributes.state === 'open',
    ),
  );
  assert.ok(
    circuitPoints.some((point) => point.attributes.state === 'rejected'),
  );
  assert.ok(
    circuitPoints.some(
      (point) => point.attributes.provider === 'anthropic' && point.attributes.state === 'half_open',
    ),
  );
  assert.ok(
    circuitPoints.some(
      (point) => point.attributes.provider === 'other' && point.attributes.state === 'closed',
    ),
  );
  await harness.runtime.shutdown();
});

test('runSpan records phase metric and a child span carrying run_id, and rethrows errors', async () => {
  const harness = await setupTelemetry();
  const result = await harness.telemetry.runSpan(
    { runId: 'run-123', operation: 'sandbox.acquire' },
    async () => 'acquired',
  );
  assert.equal(result, 'acquired');

  await harness.telemetry.runSpan(
    { runId: 'run-123', operation: 'agent.resources.upload' },
    async () => undefined,
  );
  await harness.telemetry.runSpan(
    { runId: 'run-123', operation: 'agent.runtime.create' },
    async () => undefined,
  );

  await assert.rejects(
    harness.telemetry.runSpan(
      { runId: 'run-123', operation: 'agent.execute' },
      async () => {
        throw new Error('sandbox down');
      },
    ),
    /sandbox down/,
  );

  await harness.runtime.forceFlush();
  const spans = harness.spanExporter.getFinishedSpans();
  const acquire = spans.find((span) => span.name === 'sandbox.acquire');
  assert.ok(acquire);
  assert.equal(acquire!.attributes.run_id, 'run-123');
  assert.equal(acquire!.attributes.phase, 'sandbox.acquire');
  const execute = spans.find((span) => span.name === 'agent.execute');
  assert.ok(execute);
  assert.equal(
    spans.find((span) => span.name === 'agent.resources.upload')?.attributes.phase,
    'agent.resources.upload',
  );
  assert.equal(
    spans.find((span) => span.name === 'agent.runtime.create')?.attributes.phase,
    'agent.runtime.create',
  );

  const points = await harness.collect();
  const phasePoints = points.filter((point) => point.name === 'agent.phase.duration');
  assert.ok(
    phasePoints.some(
      (point) => point.attributes.phase === 'sandbox.acquire' && point.attributes.outcome === 'success',
    ),
  );
  assert.ok(
    phasePoints.some(
      (point) => point.attributes.phase === 'agent.execute' && point.attributes.outcome === 'failure',
    ),
  );
  assert.ok(
    phasePoints.some(
      (point) => point.attributes.phase === 'agent.resources.upload' && point.attributes.outcome === 'success',
    ),
  );
  assert.ok(
    phasePoints.some(
      (point) => point.attributes.phase === 'agent.runtime.create' && point.attributes.outcome === 'success',
    ),
  );
  // phase 指标只有 phase/outcome 两个 label。
  for (const point of phasePoints) {
    assert.deepEqual(Object.keys(point.attributes).sort(), ['outcome', 'phase']);
  }
  await harness.runtime.shutdown();
});
