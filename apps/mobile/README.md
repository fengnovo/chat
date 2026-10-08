# Keen AI Mobile (React Native / Expo)

Keen AI 平台的 iOS / Android 原生客户端，直接对接 Fastify Agent API：

- **登录**：`POST /api/auth/login`，用响应体中的 JWT 走 `Authorization: Bearer`（不依赖浏览器 Cookie），token 存储在 `expo-secure-store`（Keychain / Keystore）。
- **会话列表**：keyset 游标分页、下拉刷新、新建 / 重命名 / 删除；首次发送持久化标题，打开旧的未命名会话时补齐标题。
- **聊天**：`POST /sessions/:id/runs` 发起运行，订阅原生事件流 `GET /runs/:runId/events`（SSE）实时渲染。
- **可恢复流**：SSE 断线后带 `Last-Event-ID` 自动重连，服务端从 PostgreSQL 按 seq 重放，不重跑 Agent。后台或退出 App 只断开订阅，任务由服务端 Worker 继续执行。冷启动返回上次会话，从持久化事件和服务端运行状态恢复正文、任务清单、工具详情与待处理交互，再从对应 seq 续传。
- **页面和图片**：链接在 App 内的 WebView 打开；关闭后保留实例，同一地址再次打开保留页面状态。图片点击全屏，支持双指缩放、拖动、双击和缩放按钮。
- **附件**：通过系统文件选择器上传，复用 Web 的初始化、直传 / 分片、校验、秒传协议；支持最多 5 个附件、进度、重试、移除及仅发送附件。
- **过程可见**：每轮回答只展示一次，思考 / 工具过程跟随该轮保留。工具参数、返回结果、失败状态可展开查看；工具调用 / 模型重试 / 降级 / 上下文压缩在折叠面板展示；`assistant.reasoning` 思考过程单独折叠；`todo.updated` 在输入框上方显示可折叠任务清单、完成数和当前步骤。
- **人机交互**：`approval.required` 审批卡（拒绝 / 仅批准这一次 / 本会话都允许）、`question.required` 提问卡（单选 / 多选 / 自定义补充）、运行取消。
- **契约复用**：`import type { AgentEvent } from '@repo/contracts'`，事件类型与后端 Zod schema 单一来源对齐（类型导入，零运行时开销）。

## 运行

```bash
pnpm install
pnpm mobile:run all       # 重建、安装并启动 Android + iOS 模拟器
pnpm mobile:run android   # 只运行 Android
pnpm mobile:run ios       # 只运行 iOS
pnpm mobile              # 后续 JS 开发启动 Metro
```

前置条件：本地已启动 API（`pnpm dev:api`），且 `AUTH_MODE=password`（开发账号见根 README 的 `pnpm db:seed`）。
Agent 任务还需要 `pnpm dev:worker`，也可以用 `pnpm dev` 启动项目开发服务。

`scripts/run-mobile.mjs` 自动发现或启动模拟器、复用或启动 8081 端口的 Metro，更新原生工程和 CocoaPods，增量编译后覆盖安装并重新启动 App。保留登录与会话数据。Android 优先使用 Android Studio 自带 JDK；iOS 使用 `xcodebuild` / `simctl`，兼容此机器 Xcode 27 的 Device Hub。请确保 8081 上的 Metro 属于本项目。

```bash
IOS_SIMULATOR='iPhone 17 Pro' pnpm mobile:run ios
ANDROID_AVD='Pixel_9' pnpm mobile:run android
pnpm mobile:run --help
```

日志及 iOS 构建产物位于 `node_modules/.cache/mobile/`；Android APK 位于 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。这些是供模拟器开发验证的 Debug 构建，需要 Metro；商店发布包需另外配置 Release 签名和构建。新增原生依赖后用上述脚本重建，纯 JS / TS 修改通常通过 Fast Refresh 即可更新。

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
- Agent 后台执行依赖服务端 API / Worker 持续运行；手机系统不承担 Agent 计算。
- 本地 Android 上传时，若对象存储的签名 URL 为 `127.0.0.1:59000`，运行 `adb reverse tcp:59000 tcp:59000`；真机 / 生产应配置客户端可达的 `S3_PUBLIC_ENDPOINT`。不要改写已签名 URL 的主机地址。
- 知识库管理仍使用 Web 端。

## 验证

```bash
pnpm --filter mobile test
pnpm mobile:typecheck
```

回归测试覆盖单次回答渲染、SSE 重放/重连续传、旧订阅隔离、终态处理、审批范围和多选请求。
另覆盖标题持久化、冷启动事件恢复、已回答交互去除、预览链接、图片鉴权、附件直传 / 分片 / 秒传及原生 AbortSignal 兼容。最新一轮的详细执行状态随历史一起恢复。
