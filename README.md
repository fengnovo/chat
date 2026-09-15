# Node Coding Agent Platform

这是一个面向多用户服务设计的 Node.js monorepo。Next.js Web 通过 HTTP + SSE 访问 Agent API，API 将任务写入 BullMQ，独立 Worker 在隔离 Sandbox 中运行从 `packages/ai-cli` 抽取出的 Headless Coding Agent。

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

- 三种鉴权模式：`AUTH_MODE=dev`（开发固定身份）、`AUTH_MODE=password`（本地用户名密码登录 + JWT 会话 Cookie）、`AUTH_MODE=oidc`（生产~~-  OIDC~~ JWT）。~~
- 角色级 RBAC：`admin` 超级管理员 / `owner` 知识库拥有者 / `member` 普通用户，全部数据访问强制带租户上下文实现多租户隔离。
- 知识库管理：admin 与知识库拥有者可增删改查知识库及文档；admin 可将知识库授权给指定用户（KB grants），被授权用户在聊天时可使用该知识库的 RAG 能力。
- 强制带租户上下文的 Session、Run、审批、提问、取消 API。
- Web 会话历史、切换、恢复、重命名、软删除（当前硬删除）与 keyset 游标分页。
- 新建会话立即分配独立空白 workspace，无需选择项目或上传代码。
- PostgreSQL 持久化会话、运行、事件 cursor、interrupt 和 LangGraph checkpoint。
- 开发库与独立 `agent_test` 测试库/卷隔离，集成测试不会污染本地会话列表。
- BullMQ Worker Pool、session 分布式锁和 Redis 共享模型熔断状态。
- PostgreSQL 事务 Outbox、稳定 job id、发布重试和 Redis 丢失任务自动对账。
- 可恢复 SSE：断线后从 PostgreSQL 重放事件，不会重新执行 Agent。
- Headless Agent Core：Deep Agents、MCP、模型重试、fallback、人工审批和取消。
- `deep` driver：调用真实模型，并在 E2B-compatible Sandbox 的 workspace 中运行 coding agent。
- 开发环境默认连接本机 Docker Sandbox；生产环境使用 E2B Cloud。
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

### Electron 本地客户端

```bash
pnpm desktop:dev
```

该命令会自动启动本地基础设施、执行数据库迁移、拉起 Web/API/Worker，并在 Web 就绪后打开 Electron。关闭 Electron 后自动启动的开发服务会停止。远程 Web 或已自行启动基础设施时，可参考 [apps/desktop/README.md](apps/desktop/README.md) 中的覆盖配置。

启动 Worker 前需在 `.env` 配置真实模型密钥和 Sandbox 凭据：

monorepo 只读取并维护根目录这一份 `.env`，`packages/ai-cli` 不再保存独立环境文件；同名变量以根目录配置为准。

```dotenv
AGENT_DRIVER=deep
MODEL=openai:gpt-4o-mini
OPENAI_API_KEY=...
E2B_API_KEY=...
# 沙箱运行时：e2b-cloud（默认）或 local-e2b（本机 E2B-compatible Docker 服务）
SANDBOX_RUNTIME=e2b-cloud
# 可选 endpoint 覆盖，dev 与线上环境均生效；local-e2b 未设置时回退到以下地址
E2B_API_URL=http://localhost:10087
E2B_SANDBOX_URL=http://localhost:10087
# FALLBACK_MODELS=anthropic:claude-sonnet-4
# ANTHROPIC_API_KEY=...
# MCP_CONFIG_PATH=/absolute/path/to/mcp.json
```

生产环境必须设置 `NODE_ENV=production`、`AUTH_MODE=oidc`、OIDC issuer/audience/JWKS，并替换数据库、Redis 和对象存储配置。沙箱模式不再由 `NODE_ENV` 决定，任何环境只要设置 `SANDBOX_RUNTIME=local-e2b` 即可连接本机 E2B-compatible Docker 服务；未设置 `E2B_API_URL` / `E2B_SANDBOX_URL` 时回退到 `http://localhost:10087`。默认 `e2b-cloud` 使用 `E2B_API_KEY` 连接 E2B Cloud。JWT 的 `sub` 和 `tenant_id` 需由身份网关映射为平台内部 UUID；API 会拒绝以 dev identity 在生产环境启动。

### 登录与角色 RBAC

`AUTH_MODE=password` 提供本地用户名密码登录（Web 登录页 `/login`），会话以 HTTP-only Cookie 中的 JWT 承载。配置：

```dotenv
AUTH_MODE=password
AUTH_JWT_SECRET=<openssl rand -hex 32 生成，至少 32 字符>
```

执行 `pnpm db:seed`（见 packages/db）写入默认租户与三个演示账号：

| 账号 | 密码 | 角色 | 权限 |
| --- | --- | --- | --- |
| `admin` | `admin123` | `admin` | 超级管理员：管理所有知识库（增删改查）、在 `/admin/users` 创建用户/分配角色、将知识库授权给任意用户 |
| `owner` | `owner123` | `owner` | 知识库拥有者：对自己拥有的知识库可增删改查及上传文档 |
| `user` | `user123` | `member` | 普通用户：仅可浏览被授权（admin 授权）的知识库，并在聊天时使用其 RAG 能力 |

权限在数据库查询谓词层强制执行（租户 + 角色 + KB 授权三重过滤），前端仅按角色显隐入口，不作为安全边界。

### 自助注册与提权流程

`AUTH_MODE=password` 下，登录页提供 `/register` 自助注册入口（后端 `POST /api/auth/register`）：

- 注册需用户名（3-64 位字母/数字/`._-`）、显示名、密码（≥8 位）；新账号一律为 `member`，加入 `SIGNUP_TENANT_ID` 指定的租户（默认 seed 默认租户，与 admin 同租户）。
- 注册成功即自动登录（直接下发会话 Cookie）。
- 开关 `AUTH_SIGNUP_ENABLED`：未配置时，开发/测试环境开放、生产环境关闭；生产如需开放必须显式设为 `true`。注册与登录共用同一 IP 限流桶。
- 典型提权流程：新用户注册（member）→ admin 在 `/admin/users` 将其角色改为 `owner`（或将知识库授权给该 member）→ 该用户即可管理知识库或在聊天中使用被授权的 RAG 知识库。全程无需直接操作数据库。

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

认证与管理 API：

```text
POST /api/auth/login        用户名密码登录，写入 HTTP-only 会话 Cookie
POST /api/auth/register     自助注册（默认 member，受 AUTH_SIGNUP_ENABLED 开关控制）
POST /api/auth/logout       清除会话 Cookie
GET  /api/auth/me           当前登录用户（含角色）
GET  /api/admin/users                       列出租户内用户（仅 admin）
POST /api/admin/users                       创建用户并分配角色（仅 admin）
PATCH /api/admin/users/:userId              修改角色/显示名/重置密码（仅 admin）
GET  /api/admin/users/:userId/knowledge-bases   查询用户被授权的知识库（仅 admin）
PUT  /api/admin/users/:userId/knowledge-bases   全量替换用户的知识库授权（仅 admin）
```

兼容当前 AI SDK Web 的 `/api/chat` 与 `/api/chat/:runId/stream` 也由同一套持久化 Run/Event 机制提供。

## 当前边界

开发和生产都通过 E2B 协议运行不受信任代码，但当前 workspace 文件仍依赖 E2B sandbox ID 和 pause/resume 持续存在。生产完善时应将 workspace snapshot 或 volume 与可替换的 sandbox lease 分开管理。Artifact API 已提供带租户前缀、大小限制、SHA-256 元数据校验的 S3/MinIO 预签名上传和下载；Worker 自动提取大型日志与 diff 仍属于下一实施阶段。详细边界见 [Workspace 与 Sandbox](docs/workspace-and-sandbox.md)。
