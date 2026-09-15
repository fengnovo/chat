# Runbook：API 延迟升高 / 5xx / SSE 异常

关联告警：`APIAvailabilityBurn`、`APINonSSELatencyHigh`、`SSEFirstByteLatencyHigh`、
`SSEDisconnectSpike`、`OutboxDispatchFailing`（派发侧症状也在本手册）。

## 1. 判定影响面

打开 Grafana → Chat · API & SSE：

1. 「5xx 速率（按路由）」定位是单一路由还是全局。
2. 「HTTP 延迟」p95/p99 与「SSE 首字节延迟」确认是普通请求还是 SSE 路径。
3. Chat · Overview 看 Worker 成功率/积压是否同步异常——若同步，问题在下游
   （见 worker-backlog.md / model-provider-failure.md）。

在 Tempo 中按 `service.name=agent-api` 过滤 5xx trace，查看：

- 是否集中在某个下游 span（pg/redis/knowledge mcp/outbox）；
- span attribute 中只有错误类型，没有原始错误文本——详细文本去 Loki
  用 trace_id / request_id 关联日志。

Loki：

```logql
{service_name="agent-api"} | json | level="error"
```

## 2. 常见原因与处置

| 症状 | 常见原因 | 处置 |
| --- | --- | --- |
| 全部路由 5xx、延迟同步升高 | PG/Redis 连接耗尽 | 查 PG 连接数、Redis 慢日志；必要时扩容连接池或回滚最近版本 |
| 仅 `/api/agent/sessions/:id/runs` 慢/5xx | Outbox 派发失败或 Worker 不消费 | 见 worker-backlog.md |
| 仅 knowledge 相关路由 5xx | Knowledge Service/MCP 不可用 | Chat · Knowledge 看板；查 knowledge-service 服务与 Qdrant/S3 |
| SSE 首字节慢但普通请求正常 | Worker 领取慢（队列等待）或 PG LISTEN 延迟 | 查 queue wait p95；见 worker-backlog.md |
| SSE `server`/`error` 断连尖峰 | API 重启、OOM、反向代理超时 | `journalctl -u chat-api`；确认 Nginx proxy_read_timeout 与发布记录 |
| SSE `client` 断连高 | 客户端网络问题，非服务故障 | 一般 ticket 级，不必处理 |

## 3. 缓解与回滚

- 降级：临时调低模型用量（关闭可选知识检索）在应用配置中操作。
- 回滚：systemd 按既有发布流程 `systemctl revert chat-api` 或重新部署上一版；
  遥测配置变更不需要回滚业务版本（两者独立）。
- 维护操作期间在 Alertmanager 对 `service=agent-api` 建 silence，避免误报。

## 4. 善后

- 在 slo-and-alerts.md 演练记录表补一行；
- 若是新的故障模式，把对应 Loki 查询/Tempo 过滤条件补回本手册。
