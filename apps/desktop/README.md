# Keen AI Desktop

这是一个独立的 Electron 客户端外壳，直接加载已部署的 Keen AI Web 页面。它不内置 Next.js、API、Worker 或数据库，因此不会改变 Web 端页面和构建流程。

## 开发

先启动现有 Web 和 API 服务：

```bash
pnpm dev
```

另开终端启动 Electron。未设置环境变量时会加载 `http://localhost:3000`：

```bash
pnpm desktop:dev
```

加载远程部署：

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
