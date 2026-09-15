# 容量基线（单机 8C16G / 40G ESSD）

观测栈与业务同机部署时的资源与流量基线。数值基于当前 compose 配置
（[compose.observability.yaml](../../deploy/compose.observability.yaml)）与
PoC 实测；超出基线 2 倍先扩容/调参，再继续加业务流量。

## 1. 容器资源上限与保留期

| 组件 | 内存上限 | CPU 上限 | 数据保留 | 磁盘（默认量纲） |
|---|---|---|---|---|
| Alloy | 512 MiB | 1.00 | 不落盘（WAL 仅队列缓冲） | <100 MiB |
| Prometheus | 512 MiB | 0.75 | 7d（TSDB，本地盘） | ≈ 1~2 GB |
| Tempo | 512 MiB | 1.00 | 24h（local block） | ≈ 3~8 GB |
| Loki | 384 MiB | 0.75 | 7d（tsdb + filesystem） | ≈ 3~10 GB |
| Grafana | 384 MiB | 0.75 | provisioning 只读 + SQLite | <200 MiB |
| Alertmanager | 128 MiB | 0.25 | 静默/通知状态卷 | <50 MiB |

观测栈合计上限约 **2.4 GiB 内存 / 4.5 CPU**（限制是上限不是常驻；
空闲时常驻合计约 800 MiB~1.2 GiB）。40G 系统盘建议观测数据总量控制在 **20G 以内**，
其余留给镜像、沙箱与会话目录（见部署手册 §11 的清理 cron）。

调整保留期的位置：

- Prometheus：compose 启动参数 `--storage.tsdb.retention.time=7d`；
- Tempo：`deploy/observability/tempo/tempo.yaml` 内的 block/retention 配置；
- Loki：`loki.yaml` 的 `retention_period: 168h` + compactor 保留策略。

## 2. 采集节奏

| 项目 | 当前值 | 说明 |
|---|---|---|
| Prometheus scrape/eval | 15s | 仅自监控目标（alloy/loki/tempo/grafana/prometheus） |
| 规则组评估间隔 | 30s | 录制/告警规则均显式设 30s |
| SDK 指标导出间隔 | 60s（`OTEL_METRIC_EXPORT_INTERVAL`） | 生产保持 60s，不要为了"实时"调到 1~5s |
| Alloy batch | 5s / 1024 项（max 4096） | traces / metrics / logs 共用批处理器 |
| Alloy memory_limiter | 320 MiB，spike 20% | 触顶时拒绝接收并打 `otelcol_receiver_refused_*_total` |
| OTLP HTTP 导出队列 | queue_size 2000，retry 最长 5min（上限间隔 30s） | Tempo/Loki 短暂抖动期间靠队列+WAL 缓冲 |
| Prometheus remote-write | 8 shards，2000 samples/批，5s deadline | Alloy 侧 prometheus.remote_write 到 Prometheus |

## 3. 业务信号量级基线（单机参考）

| 信号 | 量级假设 | 主要基数来源 |
|---|---|---|
| API 请求指标 | ≤ 50 rps 峰值 | `http_route`（个位~几十个）、status_class（5 个以内） |
| Worker 任务 | ≤ 5 runs/s 峰值 | `queue` / `job_kind` 枚举 |
| 模型调用 | 跟随 run | `provider` / `model` 白名单枚举，`model_family` |
| 知识操作 | ≤ 10 ops/s | `operation` 枚举 |
| trace 量 | API 采样 5%（生产 `OTEL_TRACES_SAMPLER_ARG=0.05`），Worker run 边界必采 | 高基数字段只在 attribute |
| Langfuse | 独立采样 `LANGFUSE_SAMPLE_RATE=0.05` | GenAI 专项，单独开关 |

**红线**：任何指标 label 的 distinct 值不得随 run/用户/租户数增长。
`run_id`、`user_id`（含伪名）、`tenant_id`、`session_id`、`trace_id`
只允许出现在 trace span attribute、日志字段与 Langfuse metadata 里。
CI 的 `scripts/verify-observability.sh` 会对规则目录做静态扫描。

## 4. 容量预警观测点

在 Grafana「Chat · Telemetry Pipeline」dashboard 观察：

- `otelcol_receiver_refused_*_total` 速率 > 0：Alloy 内存/队列触顶 →
  先查业务流量突增，再提 memory_limiter 与容器上限（同步调，不要只调一边）。
- `otelcol_exporter_send_failed_*_total`：后端不可达 → 查对应 runbook；
  持续 10m 有对应 ticket/urgent 告警。
- `otelcol_exporter_queue_size` 贴近 `queue_capacity`（2000）：
  后端持续不可写，WAL 将开始丢数据。
- Prometheus TSDB 增长速率：
  `rate(prometheus_tsdb_head_series_created_total[1h])` 异常飙升通常是
  某个 label 意外高基数（排查新埋点）。
- 磁盘：node/宿主层面盯 `df`；Tempo/Loki/Prometheus 任一目录到 80% 先缩保留期。

## 5. 扩容动作的优先顺序

1. **降采样/降基数**（成本最低）：trace 采样率 0.05→0.01；排查高基数 label。
2. **缩保留期**：Tempo 24h→12h、Loki 7d→3d、Prometheus 7d→3d。
3. **加内存**：Alloy/Prometheus 512M→1G（同步 memory_limiter）。
4. **拆分**：把 Tempo/Loki 数据盘挂独立卷；或把观测栈迁出业务机
   （compose 端口全绑 127.0.0.1，迁出时需要额外反代/隧道，不要直接公网暴露）。

## 6. PoC 实测记录（2026-09，本机）

- 注入 3 rps 合成 HTTP 计数器（2 条序列）连续 7 分钟：
  Alloy → Prometheus remote-write 稳定，无 refused/send_failed；
  录制规则 `job:slo_availability:ratio_5m` 30s 内反映出错误率，
  APIAvailabilityBurn 在持续越阈 5m 后进入 firing，Alertmanager 收到并按
  severity=page 分组（webhook 指向 `.invalid` 时只记录投递失败，不影响告警状态）。
- OTel 指标命名经归一化：`.`/`-` → `_`，counter 加 `_total`，
  直方图 ms 单位换算为 `_seconds`；排查指标名时先查归一化后的名字。
