# Node Coding Agent Platform

这是一个面向多用户服务设计的 Node.js monorepo。Next.js Web 通过 HTTP + SSE 访问 Agent API，API 将任务写入 BullMQ，独立 Worker 在隔离 workspace 中运行从 `packages/ai-cli` 抽取出的 Headless Coding Agent。

```text
Next.js Web ──HTTP/SSE──> Fastify Agent API ──Outbox/BullMQ──> Agent Worker
                               │                              │
                         Postgres / Redis               Headless Agent Core
                               │                              │
                         durable events               MCP / model fallback
                               └─────────────────> workspace / sandbox
```

完整设计与后续生产化清单见 [docs/node-agent-platform-plan.md](docs/node-agent-platform-plan.md)。真实模型配置、登录现状与逐项验收步骤见 [docs/acceptance-auth-and-real-model.md](docs/acceptance-auth-and-real-model.md)。

## 当前能力

- OIDC JWT 鉴权接口，以及仅允许开发环境使用的固定 dev identity。
- 强制带租户上下文的 Session、Run、审批、提问、取消 API。
- Web 会话历史、切换、恢复、重命名、软删除与 keyset 游标分页。
- 空白项目、公开 HTTPS Git 浅克隆和本地目录上传；每条会话绑定独立 workspace。
- PostgreSQL 持久化会话、运行、事件 cursor、interrupt 和 LangGraph checkpoint。
- 开发库与独立 `agent_test` 测试库/卷隔离，集成测试不会污染本地会话列表。
- BullMQ Worker Pool、session 分布式锁和 Redis 共享模型熔断状态。
- PostgreSQL 事务 Outbox、稳定 job id、发布重试和 Redis 丢失任务自动对账。
- 可恢复 SSE：断线后从 PostgreSQL 重放事件，不会重新执行 Agent。
- Headless Agent Core：Deep Agents、MCP、模型重试、fallback、人工审批和取消。
- `demo` driver：不配置模型密钥也能完整验证 Web → API → Queue → Worker → SSE。
- `deep` driver：调用真实模型，并在 workspace 中运行 coding agent。
- MinIO 本地对象存储基础设施和 artifact 数据模型。

## 目录

```text
apps/
├── web/          Next.js Agent UI
├── api/          Fastify API 与 SSE
└── worker/       BullMQ Agent Worker

packages/
├── agent-core/   与 UI、HTTP、队列无关的 Headless Agent Runtime
├── ai-cli/       Ink CLI 适配器
├── artifacts/    S3/MinIO 项目快照与运行产物
├── contracts/    Zod API、事件与队列协议
└── db/           PostgreSQL schema、migration 与 repository

infra/compose.yaml
docs/node-agent-platform-plan.md
```

## 本地启动

要求：Node.js 22+、pnpm 11+、Docker。

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm db:migrate:test
pnpm dev
```

访问：

- Web：<http://localhost:3000>
- API 存活检查：<http://127.0.0.1:8000/health/live>
- API 就绪检查：<http://127.0.0.1:8000/health/ready>
- MinIO Console：<http://127.0.0.1:59001>

默认 `AGENT_DRIVER=demo`，适合无密钥启动和端到端验收。使用真实 Agent 时修改 `.env`：

```dotenv
AGENT_DRIVER=deep
MODEL=openai:gpt-4o-mini
OPENAI_API_KEY=...
# FALLBACK_MODELS=anthropic:claude-sonnet-4
# ANTHROPIC_API_KEY=...
# MCP_CONFIG_PATH=/absolute/path/to/mcp.json
```

生产环境必须设置 `NODE_ENV=production`、`AUTH_MODE=oidc`、OIDC issuer/audience/JWKS，并替换数据库、Redis、对象存储和 Sandbox 配置。JWT 的 `sub` 和 `tenant_id` 需由身份网关映射为平台内部 UUID；API 会拒绝以 dev identity 在生产环境启动。

## 常用命令

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm cli
pnpm infra:down
```

生产构建会生成每个内部包以及 API/Worker 的 `dist`，可分别运行：

```bash
pnpm build
pnpm --filter @repo/agent-api start:prod
pnpm --filter @repo/agent-worker start:prod
```

## 主要 API

```text
POST /api/agent/sessions
GET  /api/agent/sessions?limit=20&cursor=...
GET  /api/agent/sessions/:sessionId
GET  /api/agent/sessions/:sessionId/history
PATCH /api/agent/sessions/:sessionId
DELETE /api/agent/sessions/:sessionId
GET  /api/agent/projects
POST /api/agent/projects
POST /api/agent/projects/upload
POST /api/agent/sessions/:sessionId/runs
GET  /api/agent/runs/:runId
GET  /api/agent/runs/:runId/events
POST /api/agent/runs/:runId/approvals/:interruptId
POST /api/agent/runs/:runId/questions/:interruptId
POST /api/agent/runs/:runId/cancel
POST /api/agent/runs/:runId/artifacts
POST /api/agent/artifacts/:artifactId/complete
GET  /api/agent/artifacts/:artifactId
```

兼容当前 AI SDK Web 的 `/api/chat` 与 `/api/chat/:runId/stream` 也由同一套持久化 Run/Event 机制提供。

## 当前边界

本地默认使用受路径约束的 workspace；真正运行不受信任代码时，生产部署仍应配置容器或 microVM Sandbox、默认断网、资源配额和短期凭据。Artifact API 已提供带租户前缀、大小限制、SHA-256 元数据校验的 S3/MinIO 预签名上传和下载；Worker 自动提取大型日志与 diff 仍属于下一实施阶段。
