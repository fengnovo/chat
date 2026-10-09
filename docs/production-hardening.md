# 生产加固任务与运维说明

本轮保留 PostgreSQL、BullMQ、LangGraph 和执行租约架构，修复项目对比中列出的八项问题。

| 原问题 | 已落实的改动 |
| --- | --- |
| 权限例外与幂等隔离 | 预览／重建校验会话归属；限定会话的短期预览凭证；拒绝符号链接；请求按租户、用户、会话和完整输入判重 |
| 崩溃恢复未进入 CI | 独立 PostgreSQL／Redis 集成任务，包含真实 fencing、跨配置恢复和 SIGKILL 测试；关键用例跳过视为失败 |
| 状态提交分散 | 数据库终态事务同时保存记忆任务意图、取消未完成子任务与待处理审批；Worker 轮询持久化记忆任务 |
| 新版本解释旧任务 | 保存宿主和 Agent 执行描述；恢复前检查模型、工具、提示词、资源和 SDK 版本 |
| 不确定副作用自动重试 | 正常会话授权不再授权危险重放；历史和当前策略均安全才自动重试；第三方 MCP hint 不建立可信保证 |
| 长历史和慢客户端资源占用 | 数据库消息／文件投影、游标分页、按需加载旧消息；SSE 分页读取和背压；文本按小窗口合并后落库 |
| Agent 核心与产品混杂 | 提取 capabilities 的提示词、记忆和预览能力；集中 LangGraph 恢复／消息适配；保持现有公开接口 |
| 子任务状态难以查询 | 明确父任务附属语义与取消终态，限制子任务并发；提供授权的任务状态接口 |

## 升级顺序

先应用 `025_execution_contract.sql`、`026_history_projections.sql`，再发布 Worker、API 和客户端。使用项目现有的 `pnpm db:migrate`，确保环境指向本次要升级的数据库。迁移会回填既有完成任务的记忆意图及消息／文件投影；历史量大时，给回填和数据库锁等待预留维护时间。

旧 Run 若没有完整执行描述，恢复将以 `RECOVERY_DESCRIPTOR_MISSING` 结束；描述变化则以 `RECOVERY_INCOMPATIBLE` 结束。两者保留工作区和 checkpoint。先检查此前工具是否已经产生外部结果，再发起新 Run；不要通过删除账本或手改描述来绕过检查。需要继续原任务时，应使用支持它原有描述的运行环境及明确的迁移策略。本轮实现的是明确拒绝不兼容恢复，没有自动迁移任意旧图的能力。

宿主在获取沙箱前检查本地配置、资源、图版本和提示词。实时 MCP 工具 schema 需要连接服务发现，随后在创建图、执行工具前核对；这一发现阶段发生在沙箱准备之后。变更图状态／恢复约定时，仍需维护 `AGENT_RUNTIME_VERSION`、`AGENT_GRAPH_VERSION`；SDK、工具 schema 和提示词的实际版本／摘要也参与比较。凭证轮换和本次检索到的记忆文本不参与执行身份。

新创建的 Run 在创建事务中记录执行协议标记。若 Worker 在完整 Agent 描述提交前崩溃，并且还没有事件、工具账本或子任务记录，下一位 Worker 可以继续准备；已有宿主描述仍须完全匹配。出现执行证据但没有描述的任务按旧任务处理，避免滚动升级时将旧 Worker 已执行的任务误认为尚未执行。完整 Agent 描述始终先于图创建和工具执行提交。

## 预览

登录后的 HTML 预览入口会跳转到 15 分钟有效、只允许读取当前会话预览资源的 URL。移动端通过 `POST /api/agent/sessions/:sessionId/preview-token` 获取同类 URL。过期后从原入口重新打开。URL 不提供聊天、重建或管理权限；响应及 iframe 都限制脚本页面的同源权限。

密码登录默认使用 `AUTH_JWT_SECRET` 签名。OIDC 部署应设置至少 32 字符的 `PREVIEW_TOKEN_SECRET`，所有 API 实例使用同一值。生产工作区预览仅支持 Linux，使用 `/proc/self/fd` 和 `O_NOFOLLOW` 锚定目录／文件读取；其他平台生产模式明确拒绝服务。开发 macOS 仍可预览。单文件上限 20 MiB，嵌套项目候选目录扫描上限 128 项。重建挂载受宿主管理的 `user-data` 根目录，不把 Agent 可改成符号链接的 `workspace` 子目录直接挂载到宿主。

## 历史与推流

`GET /api/agent/sessions/:sessionId/history?limit=20&cursor=...` 每页最多 50 个 Run，返回 `nextCursor`、`hasMore`。每页消息保持时间顺序；游标继续向更早的记录读取。Web／移动端通过“加载更早消息”按需取页。文件列表每页最多 200 项，Web 支持继续加载。

历史正文来自与事件原子提交的投影，`assistant.snapshot` 替换旧正文。需要最新过程事件时，`includeLatestEvents=1` 返回最多 500 条尾部事件及完整正文投影；它不是完整审计日志。完整事件仍可按事件游标读取。

SSE 每次读取最多 500 条事件，等待 socket `drain` 后再发送下一帧。单连接待发送数据预算 2 MiB，等待上限 10 秒；超限或超时关闭订阅和连接。客户端继续使用原事件／消息流游标重连。文本批量保存最多等待 25 毫秒、合并预算 8 KiB，遇到其他事件、完成或源错误先刷新文本，始终先落库再通知。

## 任务检查

`GET /api/agent/runs/:runId/tasks` 仅返回当前用户拥有的活动会话中的 Run，包含状态、失败原因、Worker／lease、恢复次数、等待原因和子任务状态。后台子任务属于父 Run；父任务终态会取消尚未结束的子任务。Worker 关闭或审批暂停只停止本地执行，保留可恢复记录。默认同时运行三个子任务，允许配置范围为 1–10；详细语义见 `packages/agent-core/src/capabilities/README.md`。

## 验证命令

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node --test scripts/run-integration-tests.test.mjs
DATABASE_URL=postgresql://agent:agent@127.0.0.1:55433/agent_ci_test \
REDIS_URL=redis://127.0.0.1:56379/0 pnpm test:integration
```

集成测试只能指向隔离测试服务，数据库名必须包含独立的 `test` 部分。运行器不加载 `.env`，自动发现 DB／Worker 集成文件并强制包含 checkpoint 和 Agent SIGKILL 用例；跳过、空用例或子进程失败都会阻止通过。详细说明见 `docs/ci-integration-tests.md`。这些检查验证本轮正确性，不代表已经完成线上容量压测或生产发布。
