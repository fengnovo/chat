# Vite + React 开发预览 Docker 配置
# 适用于沙箱环境，复用预装的 node_modules

FROM docker.m.daocloud.io/library/node:24.14.0-bookworm-slim

# 设置工作目录
WORKDIR /app

# 复制 package.json 并安装依赖（使用国内镜像）
COPY package.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm install --no-audit --no-fund

# 暴露 Vite 端口
EXPOSE 5173

# 启动开发服务器
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]
