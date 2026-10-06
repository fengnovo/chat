# Durable Agent Execution Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for focused implementation and review. The user authorized implementation in this session.

**Goal:** 主 Agent 与子 Agent 在 Worker 崩溃后安全恢复，并通过 Tool ledger 控制重复副作用。

**Architecture:** PostgreSQL 执行租约与恢复 Outbox 驱动 Worker 接管；LangGraph sync checkpoint 负责图恢复；middleware 负责 Tool intent/result 和未知结果审批；子任务拥有独立数据库身份与 checkpoint。

**Tech Stack:** TypeScript, DeepAgents, LangGraph, PostgreSQL, BullMQ, Fastify, SSE.

**Spec:** `docs/superpowers/specs/2026-10-06-durable-agent-execution-design.md`

## Global Constraints

- 不承诺外部 Tool exactly-once；未知写工具禁止自动重放。
- 主图 thread_id=sessionId；jobId=outboxId。
- 现有业务状态与前端订阅接口兼容。
- 使用隔离测试数据库，不产生真实外部副作用。

## Task 1: Durable storage

Files: `packages/db/migrations/022_durable_execution.sql`, `packages/db/src/durable-execution.ts`, repository/export/schema integration, integration tests.

- [x] 先写租约接管、过期恢复、旧 owner 写入拒绝、Tool 结果复用、child 唯一身份的失败测试。
- [x] 实现 execution lease、recovery outbox、事务 fencing、原子事件/状态/interrupt、Tool 和 child repository。
- [x] 用 PostgreSQL 测试数据库验证真实事务与并发行为。

## Task 2: Tool replay protocol

Files: `packages/agent-core/src/tool-execution.ts`, `packages/agent-core/test/tool-execution.test.ts`.

- [x] 先写成功结果重放、Command 更新保留、unsafe 未知结果中断、稳定 key 传入、输入冲突阻断测试。
- [x] 实现稳定 hash、结果编码、middleware 与恢复错误分类。
- [x] 执行定向单元测试与类型检查。

## Task 3: Durable child graph

Files: `packages/agent-core/src/subagent.ts`, new child module if needed, child tests.

- [x] 先写同一 parent call 复用 child、child checkpoint 恢复、评审 attempt 保存、后台意图恢复的失败测试。
- [x] 实现持久化 child 接口、独立图 thread、工具 ledger scope、恢复背景上下文。
- [x] 执行定向测试，保持前台与后台派发 API 兼容。

## Task 4: Worker / graph integration

Files: contracts run jobs; worker recovery, lease and fenced checkpoint modules; worker startup/config/processor; deep-agent runtime/types; API outbox.

- [x] 先写 start vs recover、等待 interrupt、有限重试、checkpoint fencing 与 Worker 接管测试。
- [x] 增加 recover job；移除启动置失败；接入 durable storage 和工具/child 端口。
- [x] root runtime 显式恢复 checkpoint，后台汇总消息稳定标识；基础设施异常保留可恢复状态。
- [x] 终态持久化与 SSE 一致；恢复中正文使用 checkpoint 快照校正。

## Task 5: Acceptance and review

- [x] 在隔离 PostgreSQL/Redis 上使用确定性 graph 做强制 SIGKILL 与接管验收；主 Agent 的账本已完成、结果未知两种崩溃窗口，以及后台 SubAgent 的独立 checkpoint 恢复都通过，恢复任务经真实 BullMQ Worker 领取。
- [x] 执行相关包的已有定向检查、最终全仓 typecheck/build；解决发现的接线问题。
- [x] 进行全链路代码审查并修复租约、未知 Tool 与后台 child 的缺口。
- [x] 更新方案的实现与验收记录，交付本地修改。
