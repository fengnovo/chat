# Vite + React 沙箱开发预览环境

## 自动化工作流

AI 代理通过 `run-web-preview` 脚本自动完成：
1. 检测并准备项目环境（node_modules 符号链接）
2. 创建缺失的入口文件（index.html、main.tsx、App.tsx）
3. 启动 Vite 开发服务器（0.0.0.0:5173）
4. 监听文件变化，浏览器自动热更新

## 沙箱内使用

```bash
# AI 代理自动执行（无需手动操作）
run-web-preview

# 或指定子目录
run-web-preview my-website
```

## Docker Compose 启动

```bash
cd apps/web-runtime
docker-compose up --build
```

浏览器访问 `http://localhost:5173` 预览效果。

## AI 代理工作流

```
用户描述需求 → AI 修改代码 → Vite 热更新 → 浏览器自动刷新
```

1. **用户**在聊天框描述需求
2. **AI** 自动编辑 `/mnt/user-data/workspace/` 下的源文件
3. **Vite** 检测到文件变化，自动热更新
4. **浏览器** 自动刷新显示最新效果
5. 循环迭代，直到满意

## 脚本功能

`run-web-preview` 脚本会自动：

| 步骤 | 操作 |
|------|------|
| 1 | 进入项目目录 |
| 2 | 检查并链接 node_modules（复用预装依赖） |
| 3 | 创建缺失的 package.json |
| 4 | 创建缺失的 index.html |
| 5 | 创建缺失的 src/main.tsx 和 src/App.tsx |
| 6 | 停止旧的 Vite 进程（如有） |
| 7 | 启动 Vite 开发服务器（后台运行） |
| 8 | 等待服务器就绪 |
| 9 | 输出预览地址和日志 |

## 文件结构

```
/mnt/user-data/workspace/
├── package.json          # 项目依赖（自动创建）
├── index.html            # 入口 HTML（自动创建）
├── vite.config.ts        # Vite 配置（AI 创建）
└── src/
    ├── main.tsx          # 应用入口（自动创建）
    ├── App.tsx           # 主组件（自动创建）
    ├── index.css         # 样式
    ├── components/       # 组件目录
    ├── hooks/            # 自定义 Hook
    └── data/             # 数据文件
```

## 注意事项

- 服务器监听 `0.0.0.0:5173`，沙箱浏览器可访问
- 文件修改后 Vite 自动热更新，无需手动刷新
- 复用沙箱镜像预装的 `/opt/chat-web-runtime/node_modules`
- 使用国内 npm 镜像源加速
