# Runbook：模型 Provider 故障 / 熔断 / 知识检索降级

关联告警：`ModelCircuitOpen`、`ModelRetrySpike`、`ModelFallbackSpike`、
`KnowledgeServiceAvailabilityBurn`、`KnowledgeRetrievalLatencyHigh`。

## 1. 判定是 provider 还是本地管线

Chat · Overview / Worker & Agent：

- `model_circuit_total{state="open"}` 上涨：熔断器已打开，调用在本地快速失败，
  按 `provider/model` 标签定位是哪一家；
- 重试高、fallback 低：provider 抖动但仍可用；
- 重试与 fallback 同时高：主模型持续失败，正在用备用模型；
- 知识检索 p95 高但模型指标正常：问题在 Knowledge Service/Qdrant，不在 LLM。

Loki 过滤：错误只记了白名单 code（如 `unavailable`、`unauthenticated`、
`rate_limited`）与构造器名，用这些 code 判断 429/超时/鉴权。

## 2. 处置矩阵

| 观察 | 含义 | 处置 |
| --- | --- | --- |
| 429 / rate_limited 尖峰 | 触发限流 | 降低并发或联系 provider 提额；短期靠重试+fallback 吸收 |
| timeout / unavailable | provider 或网络故障 | 等待半开探测自动恢复；持续不恢复则在配置中临时下调该 provider 优先级 |
| unauthenticated | 密钥失效/欠费 | 轮换 provider key（EnvironmentFile，不入库），重启 worker |
| 全部 provider 熔断 | 外部模型大面积不可用 | 公告降级；系统行为是 run failed（可在恢复后重放），不会无限堆积调用 |
| 知识检索 p95 > 2s | Qdrant/S3/PG 慢或图遍历跳数过大 | 查 knowledge-service 看板分段 span（embed/vector.search/graph.traverse/chunks.fetch），定位慢段 |

## 3. 熔断机制要点（避免误操作）

- 熔断打开期间不要手动重启 worker「尝试恢复」——熔断有自己的半开探测，
  重启只会清空计数但不会让 provider 恢复；
- 熔断器状态在 Redis（`RedisCircuitBreakerStore`），多 worker 实例共享；
- 不要直接删 Redis 熔断 key 强制闭合：故障未恢复时会立刻重新打开并放大流量。

## 4. Langfuse 侧观察

采样命中的 run 可在 Langfuse 看每次模型调用的延迟/token/重试；
若 OTel 指标显示正常但 Langfuse 无数据，是 Langfuse 采样未中或导出问题，
见 telemetry-pipeline.md，不影响业务。
