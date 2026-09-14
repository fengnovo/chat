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

# 当前平台未签名安装包
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dist

# macOS DMG/ZIP
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dist:mac

# Windows NSIS/ZIP（建议在 Windows 或 Windows CI runner 执行）
ELECTRON_WEB_URL=https://chat.example.com pnpm desktop:dist:win
```

打包产物写入 `apps/desktop/release/`。打包应用启动时也需要提供 `ELECTRON_WEB_URL`；如果没有配置，应用会显示启动错误并退出。当前产物未包含 macOS Developer ID 公证或 Windows 代码签名。

Electron 窗口关闭了 Node 集成、启用 context isolation 和 sandbox；站外 HTTP(S) 链接交给系统浏览器打开。
