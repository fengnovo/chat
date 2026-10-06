# Agent 持久化执行与崩溃恢复技术方案

## 目标与边界

保留 DeepAgents、LangGraph、PostgreSQL、Outbox、BullMQ 和现有 SSE。补齐主 Agent crash resume、Tool 执行账本、独立子任务 checkpoint，以及多 Worker 的执行所有权。用户已经授权本方案编写与实施。

系统提供 at-least-once 调度；通过稳定执行身份、结果重放、外部幂等键及未知结果阻断控制副作用。不能为不支持幂等或结果查询的外部服务提供 exactly-once 承诺。

## 身份与状态

- `runId` 是业务执行身份；主图 `thread_id=sessionId` 延续现有会话记忆。
- `jobId=outboxId` 是调度身份；payload 保留 start / resume-approval / resume-question，增加 recover。
- PostgreSQL 保存当前 invocation payload；重新领取旧 start job 也按保存的 execution input 和 checkpoint 判断恢复。
- 保留对外 run status，额外记录 execution_state（pending/running/recovering/waiting/terminal）、lease_token、lease_epoch、lease_expires_at、checkpoint_id 和 recovery_attempts。
- failed 仅用于确定的业务失败或恢复预算耗尽；进程/暂时性基础设施故障进入恢复流程。
- 每次 graph invocation 有独立、稳定的 metadata.run_id；business_run_id 始终是业务 runId。后台汇总续轮使用不同 invocation identity，避免框架忽略新 input。

## 执行所有权与恢复

1. Worker 不再启动时批量将活跃 run 置失败。
2. 原子领取 run，分配 lease token 并增加 epoch；只有未持有有效租约的 run 可被接管。
3. 执行期间续租，失去租约立即中止本地 runtime。只有当前 owner 可以写事件、Tool 账本、子任务状态和 checkpoint。
4. 周期 reconciliation 只选择租约过期的 running run，并在同一事务标记 recovering、写 recover outbox。没有活跃 execution input 的旧任务从其原始 dispatch 取回输入。
5. recover 读取该业务 run 的最新 checkpoint。属于本 run 时以 null input 恢复；尚未写入本 run 的 input checkpoint 时用原始输入初始化。审批 response 尚未应用时重放持久化 Command，已推进则用 null。
6. 检查 checkpoint ownership；不固定回放旧 checkpoint_id，以最新提交的 checkpoint 为权威。checkpoint_id 是恢复审计与定位信息。
7. LangGraph 使用 durability=sync；PostgresSaver 的 put/putWrites 在锁定并验证 run lease 的同一数据库事务中提交，防止旧 Worker 续写。
8. graph 终态事件、run status 和 interrupt 在同一事务提交。run 已终态时重投 job 无副作用。
9. 使用有限恢复预算，BullMQ 普通重试与数据库 reconciliation 共同覆盖进程和基础设施故障。取消仍由持久化 cancel_requested_at 驱动。

## Tool Execution Ledger

稳定键为 root run + scope（主图或 child attempt）+ graph tool_call_id。使用规范化 JSON 的 input_hash 校验身份；不得使用流式事件随机 invocationId。

账本在 handler 执行前提交意图，记录 execution_id、run_id、scope_id、tool_call_id、tool_name、input_hash、input、idempotency_key、replay_policy、status、result 和 lease ownership。

- succeeded：反序列化并返回原 ToolMessage / Command，保留 graph state update。
- started/uncertain + replay_safe：按同一 idempotency key 重试。
- started/uncertain + replay_unsafe：通过现有 approval interrupt 暂停，明确告知用户外部结果未知；仅明确批准重复执行才重新执行，拒绝则返回未重放说明。
- 缺少稳定 tool_call_id、输入身份变化或账本基础设施失败：阻断执行，禁止无保护降级。
- ask_user 不进入副作用账本；spawn_subagent 依靠持久化 child identity，可安全重入。
- 内置只读工具默认可重放；未知 MCP 工具与 execute/edit/delete 等默认不可重放。允许显式工具策略配置及 schema 中的幂等参数映射，将稳定 key 传给支持的外部工具。
- 外部成功但账本写失败仍属于未知结果；账本本身不能消除该窗口。

## 独立 Child Task

子任务意图在执行或后台 ack 前写 PostgreSQL，唯一键为 parent run + parent tool_call_id。记录输入、background、独立 thread_id、attempt、评审反馈、结果及状态。每轮整改使用独立 child attempt thread，避免重新注入旧输入。

子图挂同一持久化且受 root lease 保护的 checkpointer；Tool ledger scope 为 child + attempt。父任务恢复时前台工具读取同一个 child record，子图以 null 恢复；完成结果直接复用。已完成产出先保存再评审，避免评审崩溃后重新执行子图。

后台子任务属于 root run，由数据库记录重建执行上下文，不能只依赖 Promise 数组。Worker 崩溃后新 owner 可接管；不额外引入独立子队列，避免父子争抢现有 session 锁。摘要消息使用稳定 child result message ID，checkpoint 中已有摘要则不再次汇总。取消、失败和审批等待的子任务策略与现有产品流程保持一致。

## SSE 与用户结果

保留 DB event replay + SSE live subscribe。恢复操作不重新提交用户消息。保证终态事件与状态一致；检查被中断的模型 token 重放对最终正文的影响，并使用 checkpoint 中的完成消息修正结果，避免部分 token 重复拼接。

## 已落地的改动

- migrations 022/023 增加 execution lease/fencing、恢复 outbox、工具账本、child 记录与升级前活动 run 标记。
- Worker 以 run lease 领取执行，周期续租；恢复由 reconciliation 生成 recover outbox。checkpoint、pending writes、事件与副作用账本均校验当前 lease epoch。
- run input checkpoint 未提交时，从 outbox 持久化的原始 start input 初始化；已有当前 run checkpoint 时以 null input 恢复。审批/回答 payload 只有在它仍对应当前 interrupt 时才应用。
- Tool 账本保护 graph tool call；未知外部执行结果暂停，重复审批绑定独立 request marker。不能替不支持幂等键的外部 API 承诺 exactly-once。
- child 每个 attempt 使用独立 thread，结果/评审状态落库；Worker 恢复时重建后台 child。子图与 root 共享租约和恢复 outbox，不是单独的 BullMQ worker。
- SSE 与 session history 读取 `assistant.snapshot`，修正图节点重放导致的增量正文重复；Redis 通知失败时 SSE heartbeat 重读事件表。
- 对 migration 前仍处于 running 的旧执行设置 `legacy_execution`，安全地以 `RECOVERY_LEGACY_EXECUTION` 结束并保留 workspace/checkpoint；当时没有工具账本或 fenced checkpoint metadata，不能安全推断副作用是否已发生。旧的等待审批/提问仍能由新 worker消费。

## 部署顺序与验收状态

先停止并排空旧版本 Worker，再部署新版本。这样避免不受 lease/fencing 约束的旧进程与新 owner 并发写同一 checkpoint。API/Worker 启动会应用 022/023 迁移；之后新建 run 具备完整恢复协议。升级前仍在 running 的 run 会明确进入上述安全终态，需要核对外部操作后重新提交。

全仓 `pnpm typecheck`、`pnpm test` 和 `pnpm build` 已通过。确定性 `SIGKILL` 自测连接隔离 PostgreSQL 与本地 Redis：子 Worker 分别在主 Agent Tool 账本成功提交后、外部副作用成功但 Tool 账本尚未提交时、后台 SubAgent Tool 账本成功提交后被杀死；过期 run 由数据库 outbox 重新发布，经真实 BullMQ Worker 领取并恢复。主图已提交的 Tool 结果复用账本，外部副作用未知的写操作暂停等待确认，后台 child 从独立 checkpoint 恢复；受控外部副作用都只发生一次。普通全仓测试中 Agent Core 90 项通过、3 项集成测试按默认设置跳过；隔离数据库运行的 3 个真实 SIGKILL E2E 场景全部通过。另有 DB 44、Worker 40、API 108、Web 34 项测试通过；Worker fencing 测试使用 PostgreSQL。

## 迁移与配置

新增增量 SQL migration；不清除现有 checkpoint 和运行历史。Worker 启动迁移后 reconciliation 能接管旧运行任务。持久化等待审批/提问的 run 不因重启失效。

增加 Worker lease duration、recovery interval、maximum recovery attempts 与 tool replay policy 配置。默认禁止未知写工具盲目重放。现有环境变量和 SSE 接口兼容。

## 验收

1. 主图执行中强制终止进程，新的 Worker 接管同一个 run，恢复 pending node，不重复插入用户消息。
2. Tool 结果已记账、graph checkpoint 未推进：复用账本结果，不再次产生副作用。
3. 外部 Tool 已成功但成功账本未提交：unsafe 工具暂停，safe/idempotent 工具只按稳定 key 重试。
4. 新 Worker 启动不置失败其他 Worker 正在运行的 run；旧 owner 不能写事件或 checkpoint。
5. 审批/提问跨 Worker 重启仍可恢复；取消、终态 job 重投无副作用。
6. 前台和后台子图崩溃后恢复同一 child thread，已完成 attempt 不重跑；后台 ack 后崩溃也能恢复并汇总。
7. 使用隔离测试数据库、确定性模型和受控副作用验证，避免调用真实模型或创建真实外部资源。

真实进程 E2E 命令：`RUN_INTEGRATION_TESTS=1 DATABASE_URL=postgresql://agent:agent@127.0.0.1:55433/agent_test DURABLE_E2E_REDIS_URL=redis://127.0.0.1:56379 node --conditions=development --import tsx --test test/durable-crash.e2e.test.ts`（工作目录 `packages/agent-core`）。3 个 SIGKILL 场景通过：主 Agent Tool 成功账本重放、外部副作用后账本未知时要求确认、后台 SubAgent 从 child checkpoint 恢复。使用测试 PostgreSQL 事务表模拟外部副作用，不调用真实外部服务。

## 参考

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangChain custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)
- 本项目安装的 LangGraph / PostgresSaver 源码决定具体 API 和事务适配；checkpoint 的 sync 模式不能替代外部副作用幂等。
