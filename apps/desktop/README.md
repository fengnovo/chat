# Keen AI Desktop

这是一个独立的 Electron 客户端外壳，直接加载已部署的 Keen AI Web 页面。它不内置 Next.js、API、Worker 或数据库，因此不会改变 Web 端页面和构建流程。

## 开发

桌面开发命令会自动启动本地 Docker 基础设施、执行数据库迁移、拉起 Web/API/Worker，并在 Web 就绪后打开 Electron：

```bash
pnpm desktop:dev
```

默认使用 `.env` 中的 `PORT`（没有时使用 3000），所以当前项目通常会打开 `http://localhost:3020`。关闭 Electron 后，自动启动的本地 Web/API/Worker 也会停止。

本地 `AUTH_MODE=password` 时，启动流程会执行幂等 seed，可使用 `admin/admin123`、`owner/owner123` 或 `user/user123` 登录后聊天。

如果基础设施已经由其他进程管理，可以跳过 Docker 和迁移：

```bash
DESKTOP_SKIP_LOCAL_SERVICES=1 pnpm desktop:dev
```

加载远程部署（此模式不会启动本地服务）：

```bash
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dev
```

## 检查与打包

```bash
pnpm desktop:test
pnpm desktop:typecheck
pnpm desktop:build

# 当前平台安装包（必须提供构建时的线上 Web 地址）
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dist

# macOS DMG/ZIP
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dist:mac

# Windows NSIS/ZIP（建议在 Windows 或 Windows CI runner 执行）
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dist:win
```

打包产物写入 `apps/desktop/release/`。`ELECTRON_WEB_URL` 会在构建时写入应用包，因此用户启动已打包应用时不需要再设置环境变量。直接运行 `pnpm desktop:start` 时会读取项目根目录 `.env`，并使用其中的 `PORT` 连接本地 Web。

macOS 发布包必须使用 Developer ID 证书签名并完成 notarization，否则从浏览器下载后可能显示“应用已损坏，无法打开”。CI 发布需要配置以下 GitHub Actions Secrets：`MAC_CERTIFICATE_BASE64`、`MAC_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`。未签名包只适合本机调试；临时打开本机未签名包可执行 `xattr -dr com.apple.quarantine "Keen AI.app"`。

Electron 窗口关闭了 Node 集成、启用 context isolation 和 sandbox；站外 HTTP(S) 链接交给系统浏览器打开。
