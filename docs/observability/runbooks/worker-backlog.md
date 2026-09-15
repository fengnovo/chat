# Runbook：Worker 积压 / Run 失败 / Outbox 堆积

关联告警：`WorkerRunFailureRateHigh`、`WorkerQueueBacklog`、`QueueWaitDurationHigh`、
`OutboxDispatchFailing`、`AgentPhaseFailure`。

## 1. 快速判定

Grafana → Chat · Worker & Agent：

1. 「在途/排队任务」与队列等待 p95：是**消费不动**（积压涨、等待涨）还是
   **失败重试**（失败速率高、积压不一定涨）。
2. 「Agent 阶段失败速率」定位失败阶段：
   - `session.lock.acquire`：Redis 锁/连接问题；
   - `sandbox.acquire`：Docker/E2B 沙箱后端故障（宿主 docker 服务、镜像、磁盘）；
   - `workspace.prepare`：S3/MinIO 取对象失败或磁盘满；
   - `agent.execute`：模型/工具问题，见 model-provider-failure.md；
   - `persist`：PG 写入失败。
3. 服务日志：`journalctl -u chat-worker -f`，日志带 `run_id` 短引用；
   在 Tempo 用 `worker.job.execute` 查具体 run trace，再用 trace_id 查 Loki。

## 2. Outbox 堆积（API 侧）

`OutboxDispatchFailing` 表示 API 无法把 outbox 行发布到 BullMQ：

1. 查 Redis 可达性与内存（BullMQ 要求 `maxmemory-policy=noeviction`）；
2. 查 API 日志 `operation=outbox.dispatch`；
3. Redis 恢复后 outbox 有重试/补偿机制，积压会自动追平；
   若长时间未追平，手动触发一次 API 的 outbox 扫描（重启 API 亦可）。

## 3. Worker 消费停滞

1. `systemctl status chat-worker`：服务是否在重启循环；
2. 并发度 `WORKER_CONCURRENCY` 是否与沙箱宿主容量匹配；
3. 沙箱清理：宿主 `docker ps` 看残留 sandbox 容器，运行
   `deploy/scripts/cleanup-sandboxes.sh`；
4. Worker 卡住且无法优雅退出时，`systemctl stop chat-worker`
   （TimeoutStopSec=15，会先 abort 在途任务，BullMQ 租约到期后任务自动重投，
   不会丢任务）。

## 4. Run 大面积失败

- 模型相关（429/timeout/熔断）→ model-provider-failure.md；
- 同一 run 重复失败超过 BullMQ 最大 attempts 后进死信：查死信集合并人工
  决定重放（在 API 管理台对该 run 重新入队）。
- 失败原因只能在 Loki 看完整信息；trace/metric 中只有错误类型白名单。

## 5. 发布期防重复执行

发布顺序：先 `systemctl stop chat-worker`（停止领取 → abort 在途 → 等待退出），
确认 BullMQ 中无 active 任务后再发版；API 可继续接收请求（outbox 兜底）。
