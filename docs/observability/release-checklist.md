# 可观测性发布清单

每次修改 `packages/observability`、埋点、`deploy/observability/**`、systemd 单元或
观测相关 CI 后，按本清单过一遍。硬性原则：**默认关闭、fail-open、低基数**。

## 1. PR 合并前（CI + 本机）

- [ ] `.github/workflows/observability.yml` 全绿：
      lockfile 冻结安装、observability typecheck/test/build、
      api/worker/knowledge/contracts 测试、promtool、amtool、compose config、
      dashboard JSON、敏感字段/高基数扫描。
- [ ] 本机 `bash scripts/verify-observability.sh` 全绿（装了 alloy 时含 fmt 检查）。
- [ ] 没有新增环境变量键（`.env.example` 与 `deploy/env.production.example`
      键集合被契约测试锁定；确需新增时两处一起改）。
- [ ] 新 metric 的 label 只有低基数维度；`run_id`/`user_id`/`tenant_id`/
      `session_id` 只允许出现在 span attribute 与日志，不允许进指标。
- [ ] 新 span/日志字段过一遍双层脱敏（默认 `OBSERVABILITY_CAPTURE_CONTENT=false`），
      密钥、cookie、Authorization 不出现在任何信号里。
- [ ] Langfuse 相关改动确认无双写：`apps/` 下无 langsmith 引用，
      GenAI callback 只在 Worker 构造，且受 `LANGFUSE_ENABLED` 与采样双开关控制。

## 2. 单机部署变更（systemd）

- [ ] `systemd-analyze verify deploy/systemd/*.{service,timer}` 无解析错误
      （容器内缺 `/usr/bin/node` 属预期噪声）。
- [ ] 4 个应用单元均含 `--import .../observability/dist/register.js`
      （web 用 `NODE_OPTIONS`）与 `TimeoutStopSec=15`。
- [ ] `packages/observability/dist/register.js` 已随 `app-build.sh` 构建产物就位。
- [ ] 灰度顺序：先起观测栈（Alloy/Tempo/Loki/Prometheus/AM/Grafana），
      再逐个 `systemctl restart`：knowledge → worker → api → web。
- [ ] 重启后验证：`journalctl -u chat-api` 无遥测初始化报错；
      Prometheus targets 全 up；Tempo/Loki 各能查到一条新数据。

## 3. 告警与值班

- [ ] `promtool check rules` 通过；Prometheus `/api/v1/rules` 规则数与预期一致。
- [ ] 每条 page/urgent 告警都有 `runbook_url` 且链接可达。
- [ ] Alertmanager 三条 receiver（page/urgent/ticket）在 `/api/v2/receivers` 可见。
- [ ] 发布窗口在 Alertmanager 建 service 级 silence；**不要**改 PromQL 做时间排除。
- [ ] 实弹演练（见下）至少在预发/单机跑通一次。

## 4. 实弹演练（每月或大改动后）

```bash
# 静态校验
bash scripts/verify-observability.sh

# 9 类故障逐一演练（前提：本机起完整观测栈 + 应用）
bash scripts/fault-injection-observability.sh --list
bash scripts/fault-injection-observability.sh --case 1   # Alloy 停
# ...
bash scripts/fault-injection-observability.sh --all
```

通过标准：故障窗口内 `/health/live` 持续 200，业务冒烟命令（`APP_SMOKE_CMD`）
退出码 0，组件恢复后观测数据在 1~2 个采集间隔内恢复。

合成 5xx 燃烧演练（验证 APIAvailabilityBurn 端到端）：

1. 向 Alloy OTLP 端点以 >0.2 rps 且 5xx 占比 >5% 持续注入 ≥7 分钟；
2. Prometheus 中告警依次进入 pending（5m `for` 窗口）→ firing；
3. Alertmanager `/api/v2/alerts` 能按 severity=page 收到并分组；
4. 停止注入后告警在 5m 窗口后自动 resolve（需人工确认 resolve，无残留）。

## 5. Langfuse 专项

- [ ] 默认 `LANGFUSE_ENABLED=false`；生产开启前先配置好密钥与 BASE_URL
      （仅 http(s)、无 userinfo/query/hash）。
- [ ] 采样率从低值开始（`LANGFUSE_SAMPLE_RATE=0.05`）。
- [ ] 确认 Langfuse 5xx/断网时 Worker 任务照常完成（故障脚本 case 5），
      flush/shutdown 5s 上限内返回，无任务卡住。
- [ ] userId 必须伪名化；metadata 只有 allow-list 字段。

## 6. 回滚

- [ ] 应用侧回滚只需在 `.env` 设 `OTEL_ENABLED=false`（与 `LANGFUSE_ENABLED=false`）
      后重启应用；`--import` 预载保持 no-op，无需回滚 systemd 单元。
- [ ] 观测栈回滚：`docker compose -f deploy/compose.observability.yaml down`，
      不影响 infra 与业务容器。
