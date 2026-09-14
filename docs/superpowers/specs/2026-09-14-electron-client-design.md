# Electron 客户端设计

## 目标

为现有 monorepo 增加一个独立、轻量的 Electron 客户端。开发启动时客户端自动拉起本地 Web/API/Worker，加载本地 Web 页面并复用现有登录、聊天、知识库和文件上传能力；也可通过环境变量加载已部署 Web。整个过程不修改 `apps/web` 的页面、路由、样式或构建配置。

## 范围

- 新增独立 workspace：`apps/desktop`。
- Electron 主进程负责窗口生命周期、远程站点加载、导航限制和外部链接处理。
- 使用 electron-builder 生成 macOS 与 Windows 安装产物。
- `pnpm desktop:dev` 自动启动本地基础设施、数据库迁移和现有 `pnpm dev`；未配置远程地址时按 `.env` 的 `PORT` 加载本地 Web，默认 `http://localhost:3000`。
- 通过 `ELECTRON_WEB_URL` 可跳过本地服务并加载已部署 Web；`DESKTOP_SKIP_LOCAL_SERVICES=1` 可跳过本地基础设施编排。
- 复用 `apps/web/public/keen-ai-logo.png` 生成桌面端图标资源，产品名使用 `Keen AI`。
- 根目录增加显式的桌面端开发、检查和打包命令；现有 Web 命令及页面行为保持不变。

以下内容不在本次范围内：将 API/Worker/数据库打进最终安装包、离线运行 Next.js、桌面专属页面、自动更新、系统托盘、原生菜单扩展、深链接和代码签名/公证。

## 架构

`apps/desktop` 是只包含 Electron 主进程的 workspace，不维护第二套 React 页面。`pnpm desktop:dev` 通过根目录编排脚本启动基础设施、迁移和现有 Web/API/Worker，再由 Electron 访问本地 Web；设置 `ELECTRON_WEB_URL` 时则跳过本地编排，直接访问远程站点。

```text
Electron launcher ──启动──> Docker / migrate / pnpm dev
        │                              │
        │ 创建安全 BrowserWindow         ├── Next.js Web
        ▼                              ├── Fastify API
本地或远程 Web ── HTTP/SSE ────────────┴── Agent Worker
```

桌面包不作为 `apps/web` 的依赖，`apps/web` 也不感知 Electron。隔离边界使 Web 端可以继续独立开发、构建和部署。

## 组件

### 主进程入口

主进程在 Electron ready 后创建单个窗口，默认尺寸为 1280×800，最小尺寸为 960×640。窗口在页面 ready 后显示，减少启动白屏；macOS 遵循关闭全部窗口后保留应用、点击 Dock 图标重新创建窗口的惯例。

### URL 配置

- `ELECTRON_WEB_URL`：要加载的完整 `http` 或 `https` 地址；设置后不启动本地服务。
- 未设置时使用 `.env` 的 `PORT`，没有时回退到 `http://localhost:3000`。
- 非法协议、缺少主机或包含用户名/密码的 URL 会在创建窗口前被拒绝，并给出可读错误。

配置解析放在无 Electron 依赖的纯函数模块中，以便单元测试覆盖。

### 安全边界

BrowserWindow 使用以下默认值：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- 不暴露 preload API
- 拒绝所有新的内嵌窗口

同源页面导航继续在当前窗口中进行。指向其他 `http`/`https` 来源的链接交给系统默认浏览器打开；`file:`、`javascript:`、自定义协议及来源不明的导航被拒绝。客户端不绕过 TLS 证书错误，也不向页面注入 Node 能力。

### 会话与数据流

登录 Cookie、localStorage 和 sessionStorage 由 Electron 的默认持久化 session 管理，因此现有 Web 登录与会话恢复逻辑无需修改。文件选择继续使用 Chromium 原生文件选择器；聊天 SSE 与普通 API 请求仍由本地或远程 Web 现有的同源 `/api/*` 路由处理。

## 错误处理

- 启动配置错误：显示错误对话框并退出，不创建不安全窗口。
- 首次页面加载失败：窗口显示简洁的本地错误页，包含目标地址、失败原因和“重试”按钮。
- 页面运行期间断网：保留 Chromium/应用现有状态；重新加载后由 Web 端既有恢复机制继续处理。
- 系统浏览器打开外部链接失败：记录错误，不允许链接退回 Electron 窗口加载。

错误页属于 Electron 包内静态资源，不修改 Web 页面。

## 开发与打包

计划提供以下命令：

- `pnpm desktop:dev`：启动 Docker 基础设施、迁移、Web/API/Worker，等待本地 Web 就绪后启动 Electron。
- `pnpm desktop:typecheck`：检查桌面端 TypeScript。
- `pnpm desktop:test`：运行桌面端纯逻辑测试。
- `pnpm desktop:dist`：编译主进程并生成当前平台的安装产物。

Electron 的普通 `build` 任务只编译主进程，不在根目录 `pnpm build` 中隐式生成大型安装包。安装包产物输出到 `apps/desktop/release/` 并加入忽略规则。

## 验证

### 自动验证

- URL 解析：有效地址、默认地址、非法协议、凭据和缺失主机。
- 导航策略：同源导航、外部 HTTP(S)、危险协议。
- 桌面端 TypeScript、测试和编译通过。
- 现有 Web typecheck、test 与 build 保持通过。

### 手动验收

- 单次执行 `pnpm desktop:dev` 后，Docker、Web、API、Worker 均就绪，Electron 打开本地登录页。
- 聊天、SSE、知识库、上传与剪贴板复制行为与浏览器一致。
- 站外链接在默认浏览器打开，不能获得 Electron/Node 权限。
- 关闭与重新打开客户端后，登录状态按站点 Cookie 策略保持。
- 直接运行现有 Web 开发和构建命令时，页面与路由无变化。

## 交付边界

本地编排只用于源码开发，不会把 API/Worker/数据库打入安装包。最终安装包仍需要通过 `ELECTRON_WEB_URL` 连接部署地址。本次生成未签名的本地构建产物；面向最终用户分发前，macOS 仍需要 Developer ID 签名与 notarization，Windows 建议配置代码签名证书。
