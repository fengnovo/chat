# SLO 与告警约定
SLO = Service Level Objective（服务级别目标） ：用数字明确约定“服务应该好到什么程度”，是团队对用户做的内部质量承诺。

负责人：platform team。维护窗口通过 Alertmanager silence 排除（`service` +
时间窗口），不在 PromQL 中硬编码时间段。所有规则文件：

- `deploy/observability/prometheus/rules/chat-slo.yaml`（SLO 录制 + 业务告警）
- `deploy/observability/prometheus/rules/chat-dependencies.yaml`（观测管线告警）

## SLO 一览

| SLO | 目标 | 窗口 | PromQL（核心） |
| --- | --- | --- | --- |
| API 可用性 | ≥ 99.9%（5xx/other 占比 ≤ 0.1%） | 5m 评估，30d 预算 | `job:slo_availability:ratio_5m{job="agent-api"}` |
| API 非 SSE p95 | < 500ms | 5m | `route:api_http_duration:p95_seconds_5m`（排除 `*/events`） |
| SSE 首字节 p95 | < 2s | 5m | `operation:sse_first_byte:p95_seconds_5m` |
| Worker 任务成功率 | ≥ 99% | 15m | `job:slo_worker_success:ratio_15m` |
| 队列等待 | p95 < 5m（oldest age 代理） | 5m | `queue:wait_duration:p95_seconds_5m` |
| 知识检索 p95 | < 2s（search/retrieve） | 5m | `operation:knowledge_retrieval:p95_seconds_5m` |

说明：

- 可用性计算用 `clamp_min(..., 0.000001)` 防止零流量时除零；告警额外要求
  5m 请求速率 > 0.2/s（Knowledge 为 0.1/s），低流量不误报。
- 队列「oldest age」没有直接的 gauge，用等待时长直方图 p95 代理；
  在途积压用累计 counter 差值 `queue:jobs_inflight:count` 近似，
  Worker 重启后差值自然归零。
- 全部指标 label 只有枚举值（route/method/status_class/outcome/queue/job_kind/
  provider/model/phase/operation/reason/signal），无 run_id/user_id/tenant_id。

## 告警分级

| 级别 | 响应 | 路由 | 示例 |
| --- | --- | --- | --- |
| `page` | 立即处理（7×24） | `PAGE_WEBHOOK_URL`，30m 重报 | API 5xx 快速燃烧、Worker 成功率 <99%、积压 >10、Outbox 持续失败、Prometheus 不可用 |
| `urgent` | 工作时间 1h 内 | `URGENT_WEBHOOK_URL`，2h 重报 | p95 超 SLO、SSE 断连尖峰、熔断打开、Alloy/Tempo 不可达、Alloy 拒数 |
| `ticket` | 排期跟进 | `TICKET_WEBHOOK_URL`，4h 重报 | 模型重试/降级偏高、阶段失败、Loki 不可达、导出零星失败 |

聚合：按 `service` + `alertname` + `severity` 分组；page 触发时同组
urgent/ticket 自动抑制。

## 已知缺口（后续增强）

1. **依赖中间件没有 client 侧指标**：PostgreSQL/Redis/Qdrant/S3 故障目前靠
   应用 5xx、run 失败、知识操作失败间接发现。增强方向：为 pg/ioredis/S3
   client 加 `dependency.request.duration` 直方图（label 仅 dependency/operation/
   status_class），再补独立依赖告警。
2. **Langfuse 导出失败**：`@langfuse/otel` v5 不暴露 Prometheus 指标，
   暂靠应用侧 `telemetry_export_failures_total{signal="traces"}` 与
   Langfuse 云端后台监控；需要时在 LangfuseSpanProcessor 外包一层带 counter
   的 processor。
3. **容量指标**（OTel queue size、内存/CPU per service）在 Task 12 容量基线中补。

## 演练记录

每次高优告警演练后在此追加：日期、告警名、注入方式、pending/firing 时间、
通知是否到达、runbook 是否可执行。

| 日期 | 告警 | 注入方式 | 结果 |
| --- | --- | --- | --- |
| | | | |
