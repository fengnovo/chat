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

| 构建环境 | 默认服务器 | Metro（8081） | 用途 |
| --- | --- | --- | --- |
| Debug Android | `http://10.0.2.2:8002` | 需要 | 模拟器开发、Fast Refresh |
| Debug iOS | `http://127.0.0.1:8002` | 需要 | 模拟器开发、Fast Refresh |
| Release | `https://chat.keen-tech.top` | 不需要 | 手机安装、连接线上服务 |

由 React Native 的 `__DEV__` 自动识别构建类型，登录页显示环境名称。两个环境分别保存服务器地址、登录凭据和上次会话，避免混用本地与线上账号；改为隔离存储后首次启动需要重新登录。仍使用相同应用标识，Debug 与 Release 会覆盖安装。

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

### Android 真机安装包

```bash
pnpm mobile:build:android
```

生成 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`，内置 JS 和资源，安装后不需要 Metro 或 8081。默认包含 arm64-v8a、armeabi-v7a、x86 和 x86_64 四种架构，生成通用大包；可用 `ANDROID_ARCHITECTURES` 覆盖。登录页默认填写 `https://chat.keen-tech.top`，使用线上账号登录，地址仍可修改。当前工程使用开发签名，适合内部安装验证，商店发布需配置正式签名。

Release 登录页填写手机能够访问的 HTTPS Agent API 地址。当前 Release 保留 Android 默认的明文 HTTP 限制，本地 HTTP 地址适用于 Debug 开发调试。`10.0.2.2` 是安卓模拟器专用地址，不能用于真机访问电脑。

### 服务器地址

登录页需要填 Agent API 地址：

| 环境 | 地址 |
| --- | --- |
| iOS 模拟器 | `http://127.0.0.1:8002` |
| Android 模拟器 | `http://10.0.2.2:8002` |
| 真机（同一局域网） | `http://<电脑局域网 IP>:8002` |

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

### Android 模拟器 UI E2E

先启动本地 API、Worker 和 Debug App，再运行真实原生界面测试：

```bash
pnpm mobile:run android
pnpm mobile:e2e:android
# 只检查登录页键盘，无需账号、Worker 或模型回复
pnpm mobile:e2e:android --keyboard-only
```

脚本使用 Python 3 标准库与 Android SDK 的 ADB，不依赖 Sky 界面控制服务。通过原生点击、输入、UI Automator 控件树和截图验证三个登录输入框、键盘打开时切换字段、登录、新建会话、聊天输入框避让、真实模型回复、返回列表重开、前后台切换与冷启动恢复。同时读取真实 API，确认界面创建的任务已完成且回答已持久化。

默认使用根 README 的 `admin` 开发账号；可通过 `MOBILE_E2E_USERNAME` / `MOBILE_E2E_PASSWORD` 覆盖，`MOBILE_E2E_API` 指定电脑端 API 地址（默认 `http://127.0.0.1:8002`）。多台设备时指定 `ANDROID_SERIAL`；SDK 不在默认路径时指定 `ANDROID_HOME` 或 `ADB`。

必须使用停靠在屏幕底部的软键盘，关闭 AVD 的硬件键盘（Android Studio → Device Manager → 编辑 AVD → Enable keyboard input），并冷启动。Gboard 的实体键盘工具栏和浮动键盘不会缩小底部可用区域，脚本会拒绝将零高度 IME 判为通过。完整测试输入英文账号和提示词前，将键盘切到 English，避免拼音候选在收起键盘时被取消；键盘专项测试可使用中文输入法。

测试会退出当前 App 登录，并创建一个带 `ANDROID-E2E` 标记的本地测试会话；保留 App 数据及已有会话，结束后停留在测试会话。截图、控件树、窗口状态及 `results.json` 默认保存到 `node_modules/.cache/mobile/ui-e2e-*`；可用 `--output <目录>` 指定。

回归测试覆盖单次回答渲染、SSE 重放/重连续传、旧订阅隔离、终态处理、审批范围和多选请求。
另覆盖标题持久化、冷启动事件恢复、已回答交互去除、预览链接、图片鉴权、附件直传 / 分片 / 秒传及原生 AbortSignal 兼容。最新一轮的详细执行状态随历史一起恢复。
