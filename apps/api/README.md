# Agent API

Fastify/TypeScript 服务，负责鉴权、租户隔离、Session/Run、SSE、审批、取消、Artifact 和 BullMQ 投递。

请从仓库根目录启动：

```bash
pnpm infra:up
pnpm db:migrate
pnpm dev:api
```

配置和完整架构见根目录 `README.md` 与 `docs/node-agent-platform-plan.md`；OIDC、多租户和端到端验收见 `docs/acceptance-auth-and-real-model.md`。
