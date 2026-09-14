# OpenTelemetry + Local Collector + Langfuse Observability Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不依赖或修改 `stability-availability-nodejs` 的前提下，为 `chat` 建立可验证的统一可观测性体系：OpenTelemetry 负责应用侧 Trace/Metric，Grafana Alloy 负责本地采集与转发，Prometheus/Mimir、Loki、Tempo/Grafana 负责平台观测，Langfuse 专门负责 LLM/Agent 观测；业务数据库仍是运行状态和审计事实来源。

**Architecture:** 在 monorepo 新增 server-only `packages/observability`，由 API、Worker、Knowledge Service 在业务模块加载前通过 Node `--import` 初始化。应用只向本地 Alloy OTLP 端点写入，不直接依赖后端。HTTP、SSE、BullMQ、MCP、Agent、模型、工具、沙箱和知识检索共享 trace context 与 request/run 标识。Langfuse 仅接收 GenAI 语义数据，不承载通用 HTTP/基础设施指标。

**Tech Stack:** TypeScript ESM、Node.js 22、OpenTelemetry JS SDK、OTLP HTTP/gRPC exporters、Pino、Fastify 5、BullMQ、PostgreSQL、Redis、Grafana Alloy、Prometheus/Mimir、Loki、Tempo、Grafana、Alertmanager、Langfuse、pnpm、Turbo、Vitest、Docker Compose、systemd。

**Spec:** [docs/superpowers/specs/2026-09-14-observability-monitoring-integration-design.md](../specs/2026-09-14-observability-monitoring-integration-design.md)

## Global Constraints

- 不修改、不复制、不运行时依赖 `/Users/keen/Desktop/code/projects/nodejs/stability-availability-nodejs`；只借鉴其可靠性模式（健康检查、优雅关闭、限流/熔断/缓存语义）。
- 本计划阶段只设计实现步骤；执行时每个任务必须先写测试或验证脚本，再实现对应代码。
- OTel 初始化必须发生在 Fastify、BullMQ、数据库、Redis、LangGraph 和模型 SDK 等业务模块加载之前，生产入口使用 Node `--import` 预加载编译后的注册模块。
- 观测系统故障、网络超时、队列满或后端不可用不得让 API 请求、Worker 作业、知识索引或模型调用失败；所有 exporter 使用有界队列、有限重试和最多 5 秒 flush。
- Prometheus/Mimir 标签只能使用有限集合（`service_name`、`environment`、`route`、`method`、`status_class`、`operation`、`provider`、`model_family`、`outcome` 等）；不得使用 user/tenant/session/run/job/request ID。
- 用户内容、prompt、completion、工具参数、文档正文默认不进入日志或 Trace；Langfuse `captureContent=false` 为生产默认值，显式授权后才允许采集并设置保留期。
- 生产 Worker 不同时写入 LangSmith 和 Langfuse；迁移期间只允许通过受控开关进行短期对照验证，默认关闭旧 LangSmith callback。
- 指标、日志、Trace 和 Langfuse 不是业务事实来源；运行状态、审计、账务和任务最终状态继续以 PostgreSQL 及现有 outbox/run_events 为准。
- 公开健康接口只返回 `status`、版本、组件状态和可操作建议，不暴露数据库连接串、原始异常、凭据或内部主机名；详细失败原因只进入受脱敏保护的日志。
- Alloy、Grafana、Prometheus、Loki、Tempo、Langfuse 的端口仅绑定 loopback 或私网；公网入口继续由 Nginx/认证层控制。
- HTTP 请求按请求创建短生命周期 span；BullMQ 使用 producer span + consumer span link，不把可能持续数小时的队列任务绑定在 HTTP 父 span 上。
- 先完成单机/单节点 Docker Compose 验证，再扩展到 systemd 生产部署；第一阶段不引入 Kubernetes。

## Task 1: 固化安全边界、配置契约与上线前清理

**Files:**

- Modify `/.env.example`
- Modify `/deploy/env.production.example`
- Create `/docs/observability/security-and-operations.md`
- Create `/docs/observability/runbooks/credential-rotation.md`
- Create `/docs/observability/runbooks/telemetry-outage.md`
- Create `/apps/api/test/observability-config-contract.test.ts`
- Create `/apps/worker/test/observability-config-contract.test.ts`

- [ ] 在两个 env 示例文件中加入同名、同义的配置键：`OTEL_ENABLED`、`OTEL_SERVICE_NAME`、`OTEL_ENVIRONMENT`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_TRACES_SAMPLER`、`OTEL_TRACES_SAMPLER_ARG`、`OTEL_METRIC_EXPORT_INTERVAL`、`OBSERVABILITY_CAPTURE_CONTENT`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_BASE_URL`、`LANGFUSE_ENABLED`、`LANGFUSE_SAMPLE_RATE`、`OBSERVABILITY_LOG_LEVEL`、`OBSERVABILITY_SHUTDOWN_TIMEOUT_MS`。
- [ ] 约定环境值：本地默认 `OTEL_ENABLED=false`、`OBSERVABILITY_CAPTURE_CONTENT=false`；staging 使用 100% trace 采样；production 使用 parent-based traceid ratio，初始比例 `0.05`，错误请求和显式调试 run 可提高采样但不得通过用户 ID 建标签。
- [ ] 在安全文档中明确旧 Git 历史 `.env.example` 曾出现疑似 Langfuse 凭据：上线前由密钥持有人撤销并轮换，使用 secret manager 注入，禁止把新凭据写入仓库；由安全负责人决定是否进行历史重写并保留审计记录。
- [ ] 定义保留策略：指标 30 天、普通日志 14 天、Trace 7 天、Langfuse 30 天；生产 content capture 关闭；删除请求与访问审计保留在 PostgreSQL 的既有治理流程中。
- [ ] 在两个配置契约测试中读取 `.env.example` 与 `deploy/env.production.example`，断言键集合一致、示例不含非空 secret、采样比例范围为 `[0,1]`，并断言 `OBSERVABILITY_CAPTURE_CONTENT` 默认值为 `false`。
- [ ] 运行 `pnpm vitest run apps/api/test/observability-config-contract.test.ts apps/worker/test/observability-config-contract.test.ts`，预期全部通过。
- [ ] 提交本任务：`git add .env.example deploy/env.production.example docs/observability apps/api/test/observability-config-contract.test.ts apps/worker/test/observability-config-contract.test.ts && git commit -m "docs: define observability security and config contract"`。

## Task 2: 创建 `packages/observability` 基础 SDK 与生命周期

**Files:**

- Create `/packages/observability/package.json`
- Create `/packages/observability/tsconfig.json`
- Create `/packages/observability/tsconfig.build.json`
- Create `/packages/observability/src/config.ts`
- Create `/packages/observability/src/resource.ts`
- Create `/packages/observability/src/sdk.ts`
- Create `/packages/observability/src/context.ts`
- Create `/packages/observability/src/index.ts`
- Create `/packages/observability/test/config.test.ts`
- Create `/packages/observability/test/sdk-lifecycle.test.ts`

- [ ] 将 package 加入 workspace 与 Turbo 的 typecheck/build 依赖图，保持现有 TypeScript ESM 与 Node 22 约定；依赖版本从根 `pnpm-lock.yaml` 统一解析，不在子包中引入第二套 OTel 版本。
- [ ] 在 `src/config.ts` 定义以下公开接口，并只从 `NodeJS.ProcessEnv` 读取配置：

  ```ts
  export type ObservabilityConfig = {
    enabled: boolean;
    serviceName: string;
    environment: string;
    serviceVersion: string;
    otlpEndpoint?: string;
    tracesSampleRatio: number;
    metricExportIntervalMs: number;
    captureContent: boolean;
    logLevel: string;
    shutdownTimeoutMs: number;
  };

  export function loadObservabilityConfig(
    env: NodeJS.ProcessEnv,
    defaults: { serviceName: string; serviceVersion: string },
  ): ObservabilityConfig;
  ```

- [ ] 在 `src/sdk.ts` 定义 `ObservabilityRuntime`：

  ```ts
  export type ObservabilityRuntime = {
    tracer: import('@opentelemetry/api').Tracer;
    meter: import('@opentelemetry/api').Meter;
    shutdown(timeoutMs?: number): Promise<void>;
    forceFlush(timeoutMs?: number): Promise<void>;
  };

  export function startObservability(config: ObservabilityConfig): Promise<ObservabilityRuntime>;
  ```

- [ ] 使用 OTLP exporter、BatchSpanProcessor、PeriodicExportingMetricReader 和有界队列；`enabled=false` 时返回 no-op tracer/meter，避免业务代码分支判断。
- [ ] 在 `src/resource.ts` 统一设置 `service.name`、`service.version`、`deployment.environment.name`、运行实例标识和源码版本；不得设置 user/tenant/session/run 为 Resource 属性。
- [ ] 在 `src/context.ts` 实现 W3C `traceparent`/`tracestate` 的 inject/extract，以及 `ObservabilityContext`：`{ traceparent?: string; tracestate?: string; requestId?: string }`。
- [ ] 配置 exporter 超时、重试和 shutdown deadline；shutdown 时先 `forceFlush`，超过 deadline 记录一次脱敏 warning 后返回，不抛出业务异常。
- [ ] 配置测试覆盖布尔/数字解析、非法采样比例拒绝、默认值、敏感 header 不出现在错误信息；生命周期测试使用 in-memory exporter 验证 span flush、重复 shutdown 和 exporter 失败不抛业务异常。
- [ ] 运行 `pnpm -F @repo/observability test && pnpm -F @repo/observability typecheck && pnpm -F @repo/observability build`，预期三项通过且生成可被 `--import` 加载的 `dist`。
- [ ] 提交本任务：`git add packages/observability pnpm-lock.yaml pnpm-workspace.yaml turbo.json && git commit -m "feat: add shared OpenTelemetry runtime"`。

## Task 3: 统一日志、关联字段和脱敏策略

**Files:**

- Create `/packages/observability/src/logger.ts`
- Create `/packages/observability/src/redaction.ts`
- Create `/packages/observability/src/metrics.ts`
- Modify `/packages/observability/src/index.ts`
- Create `/packages/observability/test/redaction.test.ts`
- Create `/packages/observability/test/logger.test.ts`
- Create `/packages/observability/test/metrics-cardinality.test.ts`

- [ ] 定义 `createObservabilityLogger(runtime, options)`，返回 Pino-compatible logger；标准字段固定为 `timestamp`、`level`、`service`、`environment`、`request_id`、`trace_id`、`span_id`、`operation`、`outcome`、`error.type`、`error.code`，不自动写入请求 body、Authorization、cookie、prompt 或 completion。
- [ ] 定义 `redactTelemetryValue(value, policy)` 和可组合的 Pino redact paths：`req.headers.authorization`、`req.headers.cookie`、`password`、`token`、`secret`、`apiKey`、`prompt`、`completion`、`toolArgs`、`documentContent`；对未知对象采用 allow-list 而非全量序列化。
- [ ] 定义 `normalizeRoute(url, route)`：优先使用 Fastify route template，缺失时使用有限长度的 pathname；不得将 query、UUID、文件名、用户 ID 作为 route label。
- [ ] 定义 `createCoreMetrics(meter)`，至少创建：`http.server.duration`、`http.server.requests`、`sse.connection.active`、`sse.disconnects.total`、`queue.jobs.started`、`queue.jobs.completed`、`queue.jobs.failed`、`queue.job.duration`、`model.calls.total`、`model.call.duration`、`model.tokens.input`、`model.tokens.output`、`model.retries.total`、`model.fallbacks.total`、`tool.calls.total`、`knowledge.retrieval.duration`、`telemetry.export.failures`。
- [ ] 指标 helper 只接受已枚举的 label 类型，单元测试把 100 个不同 ID 作为输入并断言导出的 time series 数量仍由固定枚举决定。
- [ ] 运行 `pnpm -F @repo/observability test`，预期脱敏测试覆盖嵌套对象、错误堆栈、header、prompt、工具参数，cardinality 测试无高基数标签。
- [ ] 提交本任务：`git add packages/observability && git commit -m "feat: standardize telemetry logging redaction and metrics"`。

## Task 4: 接入 API、SSE、健康检查和反向代理语义

**Files:**

- Modify `/apps/api/package.json`
- Modify `/apps/api/src/app.ts`
- Modify `/apps/api/src/server.ts`
- Modify `/apps/api/src/config.ts`
- Modify `/apps/api/src/routes.ts`
- Modify `/deploy/nginx/chat.conf`
- Modify `/deploy/nginx/chat.keen-tech.top.conf`
- Create `/apps/api/src/observability.ts`
- Create `/apps/api/test/observability.test.ts`
- Create `/apps/api/test/health-observability.test.ts`
- Create `/apps/api/test/proxy-context.test.ts`

- [ ] 在 API 的生产启动命令中把 `packages/observability/dist/register.js` 放入 Node `--import` 预加载链；测试入口保持可注入 no-op runtime，避免每个测试启动真实 exporter。
- [ ] 在 `app.ts` 注册 request hook：生成或接收受约束的 `x-request-id`，提取 W3C context，设置 `request_id`、`trace_id`、`span_id` 到 Pino child logger，并在响应头返回 request ID；拒绝超长或包含控制字符的外部 request ID。
- [ ] 为 Fastify HTTP route、认证失败、限流拒绝、5xx、SSE 建立 span/metric；SSE 连接记录 active gauge、首字节延迟、正常结束/客户端断开/服务端错误，不记录 token 文本。
- [ ] 显式设置 `trustProxy` 为部署 Nginx 的 loopback/private CIDR 集合，不使用 `true`；rate-limit key 和 access log 使用可信代理解析后的 client IP。Nginx 只转发 `X-Request-Id`、`traceparent`、`tracestate`，并移除外部伪造的内部 telemetry header。
- [ ] 扩展 `/health/live`、`/health/ready` 的内部数据模型：返回 `status`、版本、`checks`、`observability.enabled` 与 exporter 状态摘要；详细依赖错误写日志，不写入公共响应。ready 失败仍使用现有正确 HTTP 状态码。
- [ ] 测试：HTTP span route 名称不含 ID；代理只信任配置 CIDR；伪造 header 被覆盖；SSE 断开释放 gauge；健康响应不含 DSN、异常堆栈、密钥；OTel exporter 失败时 HTTP 仍返回业务结果。
- [ ] 运行 `pnpm -F api test && pnpm -F api typecheck && pnpm -F api build`，并用 `curl -sS http://127.0.0.1:<api-port>/health/live` 验证 JSON 不泄露内部错误。
- [ ] 提交本任务：`git add apps/api deploy/nginx && git commit -m "feat: instrument api http sse and health telemetry"`。

## Task 5: 实现 Outbox/BullMQ 传播与 Worker 任务边界

**Files:**

- Modify `/apps/api/src/outbox.ts`
- Modify `/apps/api/src/routes.ts`
- Modify `/apps/worker/src/worker.ts`
- Modify `/apps/worker/src/processor.ts`
- Modify `/apps/worker/src/config.ts`
- Modify `/packages/contracts/src/index.ts`
- Create `/apps/api/test/trace-context-outbox.test.ts`
- Create `/apps/worker/test/trace-context-consumer.test.ts`
- Create `/apps/worker/test/queue-metrics.test.ts`

- [ ] 在 contracts 中为 dispatch payload 增加可选 `observability` 对象：`traceparent?: string`、`tracestate?: string`、`requestId?: string`、`traceId?: string`；保持旧 payload 可反序列化，禁止写入 prompt、用户 token 或完整请求体。
- [ ] 在 API 创建 outbox/queue job 时用 `context.ts` inject 当前 W3C context；producer span 包含 `messaging.system=bullmq`、固定队列名、operation 和 job type，不包含 job ID 作为 metric label。
- [ ] 在 Worker 消费时 extract context 并创建独立 consumer span；对于重试/延迟任务使用 span link 或 event 关联 producer，不把 HTTP span 作为长时间父 span。`run_id`、`job_id` 仅作为 span attribute 或脱敏日志字段。
- [ ] 在 `processor.ts` 为 acquire sandbox、agent execution、persist result、outbox publish、cleanup 分段；每个终态必须记录 `outcome=completed|failed|cancelled|timed_out`，异常保留 `error.type` 与稳定错误码。
- [ ] Worker shutdown 顺序固定为：停止接收新任务、等待活动任务 deadline、flush telemetry、关闭 Redis/DB/queue；超过 deadline 输出 warning 并退出，不因 telemetry flush 拒绝而卡死。
- [ ] 测试 producer/consumer 使用 in-memory span exporter 验证 traceparent 传播、consumer span link、重试不产生无限 parent span；队列 metrics 只包含固定 queue/job/outcome 枚举；旧 payload 仍通过 contracts 测试。
- [ ] 运行 `pnpm -F api test -- trace-context-outbox.test.ts && pnpm -F worker test && pnpm -F contracts test && pnpm -F worker typecheck`，预期通过。
- [ ] 提交本任务：`git add apps/api apps/worker packages/contracts && git commit -m "feat: propagate telemetry through outbox and worker queues"`。

## Task 6: 接入 Agent、模型路由、工具和沙箱观测

**Files:**

- Modify `/packages/agent-core/src/types.ts`
- Modify `/packages/agent-core/src/deep-agent.ts`
- Modify `/packages/agent-core/src/model-router.ts`
- Modify `/apps/worker/src/processor.ts`
- Modify `/apps/worker/src/redis-circuit-breaker.ts`
- Modify `/apps/worker/src/lock.ts`
- Create `/packages/agent-core/test/telemetry-events.test.ts`
- Create `/apps/worker/test/model-telemetry.test.ts`
- Create `/apps/worker/test/sandbox-telemetry.test.ts`

- [ ] 在 agent-core types 中定义依赖倒置接口，不让 LangGraph/模型 SDK 直接依赖 Grafana 或 Langfuse：

  ```ts
  export type AgentTelemetry = {
    runSpan<T>(meta: { runId: string; operation: string }, action: () => Promise<T>): Promise<T>;
    modelCall(meta: { provider: string; modelFamily: string; operation: string; outcome: string; inputTokens?: number; outputTokens?: number; latencyMs: number }): void;
    toolCall(meta: { toolName: string; outcome: string; latencyMs: number }): void;
    event(name: 'model.retry' | 'model.fallback' | 'retrieval.completed' | 'run.terminal', attributes?: Record<string, string | number | boolean>): void;
  };
  ```

- [ ] 在 `deep-agent.ts` 将现有 `usage.updated`、`model.retry`、`model.fallback`、`tool.started`、`tool.completed`、`retrieval.completed` 和终态事件映射到上述接口；事件属性只保留 provider、model family、工具名、状态、耗时、token 数和稳定错误码。
- [ ] 在 `model-router.ts`、Redis circuit breaker 和 sandbox acquire/release 中分别记录 retry、fallback、open/half-open/rejected、acquire wait、execution duration、timeout、cleanup outcome；熔断器状态使用有限枚举。
- [ ] 在 Worker processor 中为每个 agent run 建立 LangGraph run span，设置 `run_id` 为 trace/span attribute 而非 metric label；长任务按模型调用、工具调用和持久化阶段切分。
- [ ] 测试：模拟模型超时/429/5xx 验证 retry/fallback；模拟 Redis circuit open 验证请求拒绝指标；模拟 sandbox acquire timeout 和 cleanup 失败验证终态与告警事件；usage 累计不出现负值或重复结算。
- [ ] 运行 `pnpm -F agent-core test && pnpm -F worker test -- model-telemetry.test.ts sandbox-telemetry.test.ts && pnpm -F agent-core typecheck`。
- [ ] 提交本任务：`git add packages/agent-core apps/worker && git commit -m "feat: instrument agent model tool and sandbox execution"`。

## Task 7: 接入 Knowledge Service、MCP、检索和索引作业

**Files:**

- Modify `/apps/knowledge-service/src/main.ts`
- Modify `/apps/knowledge-service/src/index.ts`
- Modify `/apps/knowledge-service/src/mcp/server.ts`
- Modify `/apps/knowledge-service/src/consumer.ts`
- Modify `/apps/knowledge-service/src/retriever.ts`
- Modify `/apps/knowledge-service/src/config.ts`
- Create `/apps/knowledge-service/test/observability.test.ts`
- Create `/apps/knowledge-service/test/mcp-context.test.ts`
- Create `/apps/knowledge-service/test/retrieval-metrics.test.ts`

- [ ] 按 API/Worker 相同方式预加载 observability 注册模块；HTTP MCP 请求提取 `traceparent`，没有上游 context 时创建 server span，并用 request ID 关联日志。
- [ ] 为 `search`、`retrieve`、`index`、`reconcile`、`consume` 建立固定 operation 名；记录 Qdrant、PostgreSQL、Redis、S3、embedding provider 的耗时、状态和稳定错误码，不记录查询原文、文档正文或向量。
- [ ] BullMQ 索引消费者复用 Task 5 的 context payload；reconciler 将数据库任务状态作为事实，telemetry 只记录尝试、重试和最终结果。
- [ ] 健康检查分别报告 API reachable、PostgreSQL、Redis、Qdrant、S3 的摘要状态；公开响应隐藏连接细节，日志包含脱敏 dependency 名与 error code。
- [ ] 测试 MCP context 传播、检索结果为空/超时、Qdrant 失败降级、重复消费幂等性；断言 query/document content 永不进入日志和 attributes。
- [ ] 运行 `pnpm -F knowledge-service test && pnpm -F knowledge-service typecheck && pnpm -F knowledge-service build`。
- [ ] 提交本任务：`git add apps/knowledge-service && git commit -m "feat: instrument knowledge service and mcp retrieval"`。

## Task 8: 增加 Worker 专项 Langfuse 适配器

**Files:**

- Modify `/packages/observability/package.json`
- Create `/packages/observability/src/langfuse.ts`
- Modify `/packages/observability/src/index.ts`
- Modify `/apps/worker/package.json`
- Modify `/apps/worker/src/processor.ts`
- Modify `/apps/worker/src/worker.ts`
- Create `/apps/worker/test/langfuse-adapter.test.ts`
- Create `/packages/observability/test/langfuse.test.ts`

- [ ] 定义 Langfuse 适配器接口：

  ```ts
  export type LangfuseRuntime = {
    enabled: boolean;
    callbacks: readonly unknown[];
    flush(timeoutMs?: number): Promise<void>;
    shutdown(timeoutMs?: number): Promise<void>;
  };

  export function createLangfuseRuntime(config: ObservabilityConfig & {
    publicKey?: string;
    secretKey?: string;
    baseUrl?: string;
    enabled: boolean;
    sampleRate: number;
  }): LangfuseRuntime;
  ```

- [ ] 使用 `@langfuse/otel` 将 GenAI spans 接入 Langfuse，使用 `@langfuse/langchain` callback 关联 LangGraph/模型/工具；适配器只能从 Worker 注入，不让 API/Knowledge Service 创建 GenAI callback。
- [ ] 将 `sessionId`、`traceId`、`userId` 映射到 Langfuse metadata 时执行 allow-list；默认只传 `run_id` 的哈希或短引用、provider、model family、environment、outcome，禁止传 prompt/completion/tool args。
- [ ] 统一 flush/shutdown，与 OTel runtime 共享 5 秒 deadline；Langfuse 无 key、采样命中失败或网络不可用时自动禁用并写一条脱敏 warning，不影响 run 结果。
- [ ] 明确旧 `packages/ai-cli/src/langsmith.ts` 不在生产 Worker 路径中加载；迁移测试完成前保持 CLI 的既有行为，但 Worker 不导入该模块。
- [ ] 测试 disabled/no-key、采样率边界、metadata 脱敏、flush 超时、Langfuse HTTP 5xx；使用 fake model + fake callback 验证一次 run 只产生一个 Langfuse trace 关联模型和工具 span。
- [ ] 运行 `pnpm -F @repo/observability test -- langfuse.test.ts && pnpm -F worker test -- langfuse-adapter.test.ts && pnpm -F worker typecheck`。
- [ ] 提交本任务：`git add packages/observability apps/worker && git commit -m "feat: add opt-in Langfuse runtime for agent runs"`。

## Task 9: 部署本地 Grafana Alloy 采集器与观测后端 PoC

**Files:**

- Create `/deploy/observability/alloy/config.alloy`
- Create `/deploy/observability/alloy/README.md`
- Create `/deploy/compose.observability.yaml`
- Create `/deploy/observability/grafana/provisioning/datasources/datasources.yaml`
- Create `/deploy/observability/grafana/provisioning/dashboards/dashboards.yaml`
- Create `/deploy/observability/tempo/tempo.yaml`
- Create `/deploy/observability/loki/loki.yaml`
- Create `/deploy/observability/prometheus/prometheus.yaml`
- Create `/deploy/observability/otel-smoke/README.md`

- [ ] Alloy 配置接收 OTLP HTTP `4318` 和 gRPC `4317`，读取 systemd journal/Docker logs，添加固定 service/environment 标签，转发 traces 到 Tempo、metrics 到 Prometheus remote write/Mimir、logs 到 Loki；所有 endpoint 使用内部 DNS 或 loopback。
- [ ] 配置 Alloy 自监控、batch、memory limiter、retry、queue 和 export failure metrics；本地采集器停止时应用仍只丢弃 telemetry，不阻断业务。
- [ ] Compose 文件只增加观测组件网络、卷和健康检查，不复制现有 PostgreSQL/Redis/MinIO/Qdrant 定义；使用明确的 compose project name 与资源上限，避免吞噬业务主机资源。
- [ ] Grafana provision datasource：Prometheus/Mimir、Loki、Tempo、Langfuse URL；关闭匿名公网访问，初始管理员凭据只通过 env/secret 注入。
- [ ] 运行 `docker compose -f deploy/compose.infra.yaml -f deploy/compose.observability.yaml config`，预期配置展开成功；运行 Alloy 配置校验命令，预期无语法错误；启动后使用 `curl http://127.0.0.1:4318/v1/traces`、Grafana datasource health 和 Alloy health endpoint 验证链路。
- [ ] 在 `deploy/observability/otel-smoke/README.md` 记录 smoke：启动 API/Worker、发一条登录请求和一条最小 run、在 Tempo 查 trace、在 Loki 查 request_id、在 Prometheus 查 `http_server_requests_total`、在 Langfuse 查对应 GenAI trace。
- [ ] 提交本任务：`git add deploy/observability deploy/compose.observability.yaml && git commit -m "ops: add local alloy and observability stack"`。

## Task 10: 建立 Dashboard、告警、SLO 和操作手册

**Files:**

- Create `/deploy/observability/prometheus/rules/chat-slo.yaml`
- Create `/deploy/observability/prometheus/rules/chat-dependencies.yaml`
- Create `/deploy/observability/grafana/dashboards/chat-overview.json`
- Create `/deploy/observability/grafana/dashboards/api-sse.json`
- Create `/deploy/observability/grafana/dashboards/worker-agent.json`
- Create `/deploy/observability/grafana/dashboards/knowledge.json`
- Create `/deploy/observability/grafana/dashboards/telemetry-health.json`
- Create `/deploy/observability/alertmanager/alertmanager.yaml`
- Create `/docs/observability/slo-and-alerts.md`
- Create `/docs/observability/runbooks/api-latency.md`
- Create `/docs/observability/runbooks/worker-backlog.md`
- Create `/docs/observability/runbooks/model-provider-failure.md`
- Create `/docs/observability/runbooks/telemetry-pipeline.md`

- [ ] 定义初始 SLO：API 可用性 `99.9%`、API 非 SSE p95 `<500ms`、SSE 首字节 p95 `<2s`、Worker 任务成功率 `>=99%`、队列 oldest age `<5m`、知识检索 p95 `<2s`；每条 SLO 写出 PromQL、窗口、排除维护时间和负责人。
- [ ] 告警至少包括：API 5xx burn、SSE disconnect spike、Worker backlog/oldest age、run failure/timeout、模型 retry/fallback spike、circuit breaker open、PostgreSQL/Redis/Qdrant/S3 dependency error、Alloy export failure、Langfuse export failure。每条告警设置 severity、for、runbook URL 和去重标签。
- [ ] Dashboard 使用 RED（Rate/Errors/Duration）、USE（Utilization/Saturation/Errors）和 GenAI（latency/tokens/cost proxy/retry/fallback）布局；所有变量只允许 service/environment/route/provider/model family 等低基数值。
- [ ] Alertmanager 路由按 `service`、`severity`、`team` 聚合；通知渠道通过 secret 注入，配置文件不写 webhook token。
- [ ] 运行 `promtool check rules deploy/observability/prometheus/rules/*.yaml`；用 JSON parser 校验全部 dashboard；手工触发一次 synthetic 5xx 和 queue backlog，确认告警进入 pending/firing 并能打开对应 runbook。
- [ ] 提交本任务：`git add deploy/observability docs/observability && git commit -m "ops: add observability dashboards slo alerts and runbooks"`。

## Task 11: 接入 systemd、合成探针和发布流程

**Files:**

- Modify `/deploy/systemd/chat-api.service`
- Modify `/deploy/systemd/chat-worker.service`
- Modify `/deploy/systemd/chat-knowledge.service`
- Modify `/deploy/systemd/chat-web.service`
- Create `/deploy/observability/synthetic/health-probe.ts`
- Create `/deploy/observability/synthetic/run-synthetic.sh`
- Create `/deploy/observability/synthetic/chat-observability-synthetic.service`
- Create `/deploy/observability/synthetic/chat-observability-synthetic.timer`
- Modify `/deploy/README.md`

- [ ] systemd 服务使用 `--import` 预加载 observability 注册模块，设置 `OTEL_SERVICE_NAME`、`OTEL_ENVIRONMENT`、`OTEL_EXPORTER_OTLP_ENDPOINT` 和 shutdown timeout；EnvironmentFile 指向受权限保护的部署文件，服务账户无权读取其他 secret。
- [ ] API、Worker、Knowledge Service 的 systemd `ExecStop` 和 `TimeoutStopSec` 与 telemetry flush deadline 对齐；Worker 先停止取新任务再等待活动任务，避免发布期间产生重复执行。
- [ ] 合成探针每 60 秒执行：live、ready、登录/鉴权失败预期、最小 chat run、最小 knowledge retrieval；探针使用专用 tenant/user、固定标签和短超时，结果只写 metrics/logs，不写真实用户内容。
- [ ] 验证部署顺序：先启动 Alloy/后端，再滚动重启 API、Knowledge、Worker；若 collector 不可用，应用健康但 telemetry pipeline 告警；若应用新版本失败，按既有 systemd 回滚，不需要回滚观测数据。
- [ ] 运行 `systemd-analyze verify deploy/systemd/*.service deploy/observability/synthetic/*.service deploy/observability/synthetic/*.timer`（在具备 systemd 的环境执行）；运行 `bash deploy/observability/synthetic/run-synthetic.sh --dry-run`，预期只打印目标 URL 和检查项，不发送真实任务。
- [ ] 提交本任务：`git add deploy/systemd deploy/observability/synthetic deploy/README.md && git commit -m "ops: wire telemetry preload and synthetic checks"`。

## Task 12: CI、故障注入、容量验证和分阶段发布

**Files:**

- Create `/.github/workflows/observability.yml`
- Create `/scripts/verify-observability.sh`
- Create `/scripts/fault-injection-observability.sh`
- Create `/docs/observability/release-checklist.md`
- Create `/docs/observability/capacity-baseline.md`

- [ ] CI workflow 在 pull request 上执行：workspace lockfile 检查、`pnpm -F @repo/observability typecheck/test/build`、API/Worker/Knowledge tests、contracts tests、`promtool check rules`、Compose config 校验、dashboard JSON 校验、敏感字段扫描；不得要求真实 Langfuse/Prometheus 凭据。
- [ ] `scripts/verify-observability.sh` 按顺序执行静态检查、单元测试、契约测试、Compose config、规则校验和 smoke 查询；每一步打印可复制的失败原因和退出码。
- [ ] `scripts/fault-injection-observability.sh` 在隔离 Compose 网络中注入：Alloy 停止、Tempo/Loki/Prometheus 不可达、Langfuse 5xx、Redis latency、PostgreSQL connection refusal、模型 429/timeout、Qdrant unavailable；断言业务请求和已持久化任务仍符合预期，且出现对应 telemetry pipeline/dependency alert。
- [ ] 建立容量基线：在 staging 以 1、10、50 并发 run 测量应用 CPU/memory、OTel queue size、export latency、Langfuse flush latency、日志吞吐、Prometheus series 数量；series 增长必须与固定枚举而非 run 数线性相关。
- [ ] 发布门禁：Task 1 安全清理完成；Task 2-8 单测和 typecheck 全绿；Task 9 smoke 能查询四类数据源；Task 10 所有高优告警可触发并有 runbook；Task 11 合成探针连续 24 小时无误报；Task 12 故障注入通过；负责人签署 rollback 和数据保留确认。
- [ ] 分阶段启用：staging 100% trace + Langfuse content off；production 5% trace + Langfuse sample 10%；观察 24 小时后逐步调整。任何 telemetry overhead 超过容量基线 20%、P95 API latency 增加超过 10% 或 exporter queue 持续积压时，关闭采样/停止 Langfuse callback，保留基础 error metrics 和 logs。
- [ ] 运行 `bash scripts/verify-observability.sh` 与隔离环境故障注入脚本；保存输出到发布制品目录，不把凭据和用户内容写入制品。
- [ ] 提交本任务：`git add .github/workflows/observability.yml scripts/verify-observability.sh scripts/fault-injection-observability.sh docs/observability && git commit -m "ci: verify observability integration and rollout gates"`。

## Final Acceptance Checklist

- [ ] `stability-availability-nodejs` 工作区无任何修改、依赖或 vendored 文件；`git -C /Users/keen/Desktop/code/projects/nodejs/stability-availability-nodejs status --short` 与执行前一致。
- [ ] API、Worker、Knowledge Service 在业务模块加载前初始化 OTel；应用启动、关闭、collector 不可用和 exporter 超时均不会破坏业务功能。
- [ ] 一次 API 发起的 chat run 可在 Tempo 看到 HTTP → outbox/queue → Worker → model/tool/sandbox → persistence 的关联 trace；日志可用 request ID/trace ID 跳转；指标没有 run/user/job 高基数标签。
- [ ] 一次 knowledge retrieval 可在 MCP/API → Knowledge Service → PostgreSQL/Redis/Qdrant/S3 的 trace 中定位，查询原文与文档正文不进入 telemetry。
- [ ] 一次模型调用在 Langfuse 中显示 provider/model/latency/token/retry/fallback/outcome，并与 OTel trace 通过受控 ID 关联；production 默认不采集内容，Worker 不双写 LangSmith。
- [ ] Grafana 四类 dashboard 可用，Prometheus/Loki/Tempo/Langfuse 数据源健康，至少一条高优告警和一条 telemetry pipeline 告警完成演练。
- [ ] 所有单元、集成、E2E、fault injection、静态安全检查通过；运行结果、采样比例、保留期、回滚点和剩余风险写入发布 checklist。

## Execution Notes

此计划按“共享 SDK → 应用接入 → Langfuse → 采集器/后端 → 告警/发布验证”顺序拆分，是因为各阶段共享配置、context 和指标契约；每个任务都拥有独立测试和提交点，可在单一分支中按顺序执行，也可使用 `superpowers:subagent-driven-development` 按任务分配后逐个合并。当前批准范围只包括计划文档，不执行上述代码、依赖安装、服务启动或提交操作。
