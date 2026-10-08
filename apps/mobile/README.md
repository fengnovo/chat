# Keen AI Mobile (React Native / Expo)

Keen AI 平台的 iOS / Android 原生客户端，直接对接 Fastify Agent API：

- **登录**：`POST /api/auth/login`，用响应体中的 JWT 走 `Authorization: Bearer`（不依赖浏览器 Cookie），token 存储在 `expo-secure-store`（Keychain / Keystore）。
- **会话列表**：keyset 游标分页、下拉刷新、新建 / 重命名 / 删除。
- **聊天**：`POST /sessions/:id/runs` 发起运行，订阅原生事件流 `GET /runs/:runId/events`（SSE）实时渲染。
- **可恢复流**：SSE 断线后带 `Last-Event-ID` 自动重连，服务端从 PostgreSQL 按 seq 重放，不重跑 Agent。App 退后台再回来也能自动续传。
- **过程可见**：每轮回答只展示一次，思考 / 工具过程跟随该轮保留。工具参数、返回结果、失败状态可展开查看；工具调用 / 模型重试 / 降级 / 上下文压缩在折叠面板展示；`assistant.reasoning` 思考过程单独折叠；`todo.updated` 在输入框上方显示可折叠任务清单、完成数和当前步骤。
- **人机交互**：`approval.required` 审批卡（拒绝 / 仅批准这一次 / 本会话都允许）、`question.required` 提问卡（单选 / 多选 / 自定义补充）、运行取消。
- **契约复用**：`import type { AgentEvent } from '@repo/contracts'`，事件类型与后端 Zod schema 单一来源对齐（类型导入，零运行时开销）。

## 运行

```bash
pnpm install
pnpm mobile            # expo start，然后 i / a 打开模拟器
```

前置条件：本地已启动 API（`pnpm dev:api`），且 `AUTH_MODE=password`（开发账号见根 README 的 `pnpm db:seed`）。

### 服务器地址

登录页需要填 Agent API 地址：

| 环境 | 地址 |
| --- | --- |
| iOS 模拟器 | `http://127.0.0.1:8002` |
| Android 模拟器 | `http://10.0.2.2:8002` |
| 真机（同一局域网） | `http://<电脑局域网 IP>:8000` |

> 真机调试还需要 API 监听 `0.0.0.0` 并允许局域网访问（默认开发配置即是）。

## 目录

```text
apps/mobile/
├── app.json                Expo 配置（bundleId、深色主题、新架构）
├── index.ts                入口（registerRootComponent）
└── src/
    ├── App.tsx             导航（登录 ↔ 会话列表 → 聊天）
    ├── api/
    │   ├── client.ts       HTTP 客户端（Bearer 鉴权、SecureStore 持久化）
    │   ├── sse.ts          可恢复 SSE 流（expo/fetch + Last-Event-ID 重连）
    │   └── types.ts        复用 @repo/contracts 的事件类型
    ├── chat/               消息状态、事件去重、工具过程数据
    ├── store/auth.tsx      登录态（冷启动恢复 + /auth/me 校验）
    ├── screens/            Login / Sessions / Chat
    └── components/         消息气泡、思考过程、过程面板、审批/提问卡
```

## 已知边界

- 推送通知未接入（App 在后台时 SSE 挂起，回到前台自动续传）；生产化需要 FCM / APNs 集成。
- 附件上传、知识库管理等能力暂未覆盖，走 Web 端。

## 验证

```bash
pnpm --filter mobile test
pnpm mobile:typecheck
```

回归测试覆盖单次回答渲染、SSE 重放/重连续传、旧订阅隔离、终态处理、审批范围和多选请求。
历史接口目前只返回正文和思考过程；退出页面后重新打开，已结束任务的工具详情和任务清单不会从历史恢复。
