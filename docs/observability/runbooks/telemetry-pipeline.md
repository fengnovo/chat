# Runbook：遥测管线故障（Alloy / Tempo / Loki / Prometheus / Langfuse）

核心原则：**遥测故障永远不是业务故障**。应用侧 exporter 非阻塞且 fail-open，
collector 停摆时只丢遥测。处置期间不要为了修监控而重启业务服务。

关联告警：`AlloyCollectorDown`、`TempoDown`、`LokiDown`、`PrometheusDown`、
`AlloyTraceExportFailures`、`AlloyMetricExportFailures`、`AlloyLogExportFailures`、
`AlloyReceiverRefusing`、`ApplicationTelemetryExportFailures`、
`PrometheusRemoteWriteFailing`。

## 1. 分层定位

| 层 | 检查 |
| --- | --- |
| 应用 SDK | `telemetry_export_failures_total`（按 job/signal）；日志里只出现脱敏告警 |
| 接收 | Alloy `/ready` 与 UI（127.0.0.1:12345），`otelcol_receiver_refused_*` |
| 队列 | `otelcol_exporter_queue_size`、`otelcol_exporter_send_failed_*` |
| 后端 | 各组件 `up`、Tempo `/ready`、Loki `/ready`、Prometheus `/-/ready` |

## 2. 常见故障

### Alloy 宕机
`docker compose -f deploy/compose.observability.yaml restart alloy`。
应用在这期间继续服务；恢复后积压在 SDK batch 有效期内的数据会自动补发，
超出 batch 保留的数据丢失是预期行为。

### Alloy 拒数（memory limiter）
`AlloyReceiverRefusing` 表示下游长时间不通、collector 内存触顶：
1. 先恢复真正不通的后端（Tempo/Loki/Prometheus 容器健康）；
2. 队列排空后拒数自动停止；
3. 若常态触顶，调高 compose 内存上限与 `memory_limiter.limit`，
   不要在应用侧提高采样来「解决」。

### Tempo/Loki/Prometheus 容器不健康
按 `compose.observability.yaml` 的 healthcheck 与卷判断；磁盘满是最常见原因
（`chat-obs-*-data` 卷）。清理后重启对应单组件即可，组件之间无状态耦合。

### Prometheus remote-write 失败
检查 prometheus 是否带 `--web.enable-remote-write-receiver` 启动，
以及 Allo 与 prometheus 是否在同一 compose 网络。

### Langfuse 无数据
1. 应用 env：`LANGFUSE_ENABLED=true` 且 key 齐全（缺 key 时启动日志有一条
   脱敏 warning 并自动禁用）；
2. 采样：`LANGFUSE_SAMPLE_RATE`，未命中不建 trace 属正常；
3. 生产默认不采内容，UI 看不到 prompt 是预期而非故障；
4. Langfuse processor 挂在共享 tracer provider 上，随 OTel runtime
   5s deadline 一起 flush，shutdown 不单独等待。

## 3. 验证恢复

按 `deploy/observability/otel-smoke/README.md` 发一条 OTLP smoke，
确认 Tempo 可查 trace、Prometheus 可查 metric、Loki 可查日志；
管线告警自动 resolve（无需手工清除）。
