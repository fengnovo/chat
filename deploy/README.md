# 部署手册

面向：**1 台 8 核 16G / 40G 系统盘 / 3Mbps 的 ECS（Debian 12）**，先跑通聊天 + Agent + 沙箱。

## 0. 本次范围（重要）

| 组件 | 本次 | 说明 |
|---|---|---|
| Postgres / Redis / MinIO | ✅ Docker Compose | `deploy/compose.infra.yaml` |
| Web / API / Worker | ✅ systemd 宿主机进程 | Worker 需要宿主 Docker，见 §1.3 |
| Docker 沙箱 | ✅ 宿主 Docker | 需预先构建 `chat-agent-sandbox` 镜像 |
| **knowledge-service** | ✅ systemd 宿主机进程 | |

> 本目录下**全部是新增文件**，仓库里任何现有文件都没有被修改。

---

## 1. 前置条件

### 1.1 服务器
- 8 核 / 16 GB / 40 GB 系统盘（ESSD），Debian 12 或 Ubuntu 22.04+
- 公网带宽 3 Mbps（只有浏览器下载走上限；上传不受影响）

### 1.2 安全组（只开这些）
| 端口 | 用途 | 来源 |
|---|---|---|
| 22 | SSH | 你的固定 IP |
| 80 | HTTP → HTTPS 跳转 + Let's Encrypt 校验 | 0.0.0.0/0 |
| 443 | Web + API | 0.0.0.0/0 |
| 9443 | MinIO 预签名直传/下载（§8.3） | 0.0.0.0/0 |

**不要**对外开放 3020 / 8002 / 55432 / 56379 / 59000 —— 这些在 `.env` 里都绑定在 127.0.0.1。

### 1.3 为什么应用跑在宿主机而不是 Docker
Worker 通过 `spawn('docker', ['run', ...])` 创建沙箱容器，并把宿主目录 bind mount 进去。
如果 Worker 本身跑在容器里，挂载路径和宿主机路径对不上，沙箱会挂载失败。
所以：**基础设施用 Compose，应用用 systemd。**

### 1.4 域名与 HTTPS（硬性要求）
`AUTH_MODE=password` 时，生产环境的会话 cookie 是 `Secure` 的 —— **没有 HTTPS 就登录不了**
（表现为"登录成功但立刻跳回登录页"）。两种方案：

- **有域名且已完成 ICP 备案**：用 Let's Encrypt（§8.2），推荐。
- **没有域名 / 未备案**：用自签证书（§8.4）。大陆地域未备案的域名在 80/443 会被拦截，
  可以用非标准端口（如 8443）+ 自签证书先验证。

---

## 2. 把代码固化下来

工作区里有一批**未提交**的改动（密码登录、注册、admin 用户管理、迁移 010 等），
其中 `AUTH_MODE=password` 是这个功能才有的。直接部署工作区无法复现，建议先提交：

```bash
# 在本地 worktree 里
git add -A && git commit -m "feat: password auth, admin user management and kb grants"
git push   # 或者在下一节用 rsync 直接把工作区传上去
```

> 我没动任何代码；这一步需要你自己决定提交信息。

---

## 3. 系统初始化

```bash
# 上传 deploy 目录后（或在服务器上已有仓库时）
sudo bash /opt/chat/deploy/scripts/host-setup.sh
```

脚本做这些事：装 Docker（官方源）+ Nginx + certbot；配置 Docker 日志上限（`max-size=10m`，
否则沙箱容器日志会吃满磁盘）；装 Node 22 + pnpm 11；创建 `chatapp` 用户并加入 `docker` 组；
创建 `/opt/chat/data/{workspaces,sandboxes}`。

可选环境变量：
```bash
# 阿里云容器镜像加速（控制台可获取专属地址），加快拉镜像
sudo DOCKER_MIRROR=https://xxxx.mirror.aliyuncs.com bash deploy/scripts/host-setup.sh
# 4G swap（16G 内存不必须）
sudo SWAP_GB=4 bash deploy/scripts/host-setup.sh
```

---

## 4. 代码就位

```bash
sudo mkdir -p /opt/chat && sudo chown chatapp:chatapp /opt/chat
```

**方式 A：git**
```bash
sudo -iu chatapp git clone <你的仓库> /opt/chat
cd /opt/chat && git checkout <要部署的分支/commit>
```

**方式 B：从本地 rsync（未提交也能用）**
```bash
rsync -av --delete \
  --exclude node_modules --exclude .next --exclude dist --exclude .turbo \
  --exclude .git --exclude data \
  ./ chatapp@<服务器IP>:/opt/chat/
```

> `node_modules` / `.next` / `dist` 都不要传：它们含平台相关的原生二进制，
> 必须在目标机上重新安装构建。

---

## 5. 配置 `.env`

```bash
cd /opt/chat
cp deploy/env.production.example .env
chmod 600 .env
```

必改项（其余看注释）：

```bash
# 生成三处密钥
openssl rand -hex 32   # → AUTH_JWT_SECRET
openssl rand -hex 16   # → POSTGRES_PASSWORD（同时替换 DATABASE_URL 里的密码）
openssl rand -hex 16   # → MINIO_ROOT_PASSWORD
```

| 变量 | 值 |
|---|---|
| `WEB_ORIGIN` | `https://你的域名`（自签方案填 `https://公网IP`） |
| `S3_PUBLIC_ENDPOINT` | `https://你的域名:9443` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | 与 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` 一致 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL` | 你的模型服务 |
| `AUTH_JWT_SECRET` | 上一步生成，≥32 字符 |
| `EMBEDDING_PROFILE` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | **即使不上知识库也必须填全**，否则 API 拒绝启动 |

---

## 6. 启动基础设施

```bash
cd /opt/chat
docker compose -f deploy/compose.infra.yaml --env-file .env up -d --wait
docker compose -f deploy/compose.infra.yaml ps
```

---

## 7. 迁移数据库 + 建账号

```bash
cd /opt/chat
pnpm install --frozen-lockfile        # 若报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY，加 CI=true
pnpm db:migrate
pnpm db:seed                          # 建默认租户 + admin/owner/user 三个账号
```

> API 启动时也会自动迁移，但显式跑一次更清楚。

**立刻改掉种子密码**（三个账号默认 `admin123` / `owner123` / `user123`）：

```bash
BASE=http://127.0.0.1:8002
# 1) 用 admin 登录，cookie 存到文件
curl -s -c /tmp/admin.jar -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}' $BASE/api/auth/login

# 2) 查用户列表拿 id
curl -s -b /tmp/admin.jar $BASE/api/admin/users | jq '.data[] | {id, username, role}'

# 3) 改密码（把 <uid> 换成上一步的 id）
curl -s -b /tmp/admin.jar -X PATCH -H 'content-type: application/json' \
  -d '{"password":"改成你自己的强密码"}' $BASE/api/admin/users/<uid>

# 4) 为第 2 个人建号
curl -s -b /tmp/admin.jar -X POST -H 'content-type: application/json' \
  -d '{"username":"alice","displayName":"Alice","password":"另一个强密码","role":"member"}' \
  $BASE/api/admin/users
```

> 也可以临时设 `AUTH_SIGNUP_ENABLED=true`，让两个人在 `/register` 自助注册（自动是 member）。

---

## 8. 构建发布

```bash
cd /opt/chat
bash deploy/scripts/app-build.sh
```

它依次做：`pnpm install --frozen-lockfile` → `pnpm build` → 构建沙箱镜像
（`docker build -f infra/sandbox/Dockerfile -t chat-agent-sandbox:latest infra/sandbox`）
→ 安装 3 个 systemd unit → 重启服务 → 自检 `/health/ready`。

沙箱镜像要下载约 1 GB（apt + pip 科学栈 + vite/react），国内直连 pypi.org 会慢。
加速方式（不改仓库文件）：

```bash
cd /opt/chat
docker build -f deploy/sandbox/Dockerfile.mirror -t chat-agent-sandbox:latest infra/sandbox
```

`pnpm install` 慢的话：`pnpm config set registry https://registry.npmmirror.com`。

---

## 9. Nginx + HTTPS

### 9.1 装配置
```bash
sudo cp /opt/chat/deploy/nginx/chat.conf /etc/nginx/conf.d/chat.conf
sudo sed -i 's/chat\.example\.com/你的域名/g' /etc/nginx/conf.d/chat.conf
```

### 9.2 签发证书（有备案域名）
```bash
sudo mkdir -p /var/www/certbot
sudo certbot --nginx -d 你的域名
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run     # 确认自动续期
```

### 9.3 关键配置说明
- `proxy_buffering off` + `chunked_transfer_encoding on` + 长超时：**SSE 流式输出必需**，
  少了这些聊天会一次性卡住不出字。
- `/api/` 直接转发到 `8002`，绕过 Next 的 rewrite，少一跳、流式更稳。
- MinIO 那段的 `proxy_set_header Host $http_host;` **必须保留端口**：
  预签名 URL 的 SigV4 签名包含 Host，丢了端口会 `SignatureDoesNotMatch`。
- `location = /knowledge { return 404; }` 暂时挡掉知识库页面（§11）。启用后删掉。

### 9.4 没有域名：自签证书
```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/chat.key -out /etc/nginx/ssl/chat.crt \
  -subj "/CN=你的公网IP" -addext "subjectAltName=IP:你的公网IP"
```
把 `chat.conf` 里的 `ssl_certificate*` 指到上面两个文件、`server_name` 改成 IP、
`listen 443 ssl` 改成 `listen 8443 ssl`，并把 `.env` 的 `WEB_ORIGIN` 与
`S3_PUBLIC_ENDPOINT` 改成 `https://IP:8443` / `https://IP:9443`，安全组放行 8443。
浏览器首次访问需要手动信任证书。

---

## 10. 验收清单

```bash
# 1) 进程与健康
systemctl status chat-api chat-worker chat-web --no-pager
curl -s http://127.0.0.1:8002/health/live
curl -s http://127.0.0.1:8002/health/ready      # 期望 {"status":"ready"}（含 pg/redis/s3 探测）

# 2) 外网入口
curl -I https://你的域名/

# 3) 跑一条消息时观察沙箱
docker ps --filter name=docker-            # 执行中应能看到临时容器
watch -n2 'ls -la /opt/chat/data/sandboxes'
```

浏览器验收：
- [ ] 用 admin 登录成功，刷新后仍是登录态（验证 cookie + HTTPS 正确）
- [ ] 新建会话、发一条消息，**逐字流式输出**（验证 SSE 没被 Nginx 缓冲）
- [ ] 第 2 个账号能同时使用，两边互不干扰
- [ ] 让 Agent 跑一次多步任务（写文件/执行命令），确认沙箱正常
- [ ] 历史会话刷新后仍在，可切换、重命名、删除
- [ ] `journalctl -u chat-worker -f` 无持续报错

---

## 11. 日常运维

```bash
# 日志
journalctl -u chat-api -f
journalctl -u chat-worker -f
journalctl -u chat-web -f

# 更新代码后重新发布
cd /opt/chat && git pull && bash deploy/scripts/app-build.sh

# 基础设施
docker compose -f deploy/compose.infra.yaml --env-file .env ps
docker compose -f deploy/compose.infra.yaml --env-file .env logs -f postgres

# 备份（数据库 + 对象存储）
docker compose -f deploy/compose.infra.yaml --env-file .env exec -T postgres \
  pg_dump -U agent agent | gzip > /root/backup-$(date +%F).sql.gz

# 磁盘（40G 要盯着）
df -h /                    # 系统盘
docker system df           # 镜像/容器占用
pnpm store prune           # 清理 pnpm 全局存储
```

**务必加清理定时任务**：会话目录没有 TTL，不清理会把 40G 吃满。

```bash
sudo crontab -e
30 4 * * * /opt/chat/deploy/scripts/cleanup-sandboxes.sh >> /var/log/chat-cleanup.log 2>&1
```

---

## 12. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录成功但立刻跳回登录页 | 走的是 HTTP，`Secure` cookie 存不下 | 必须 HTTPS；检查 `WEB_ORIGIN` 与实际访问地址一致 |
| API 起不来：`AUTH_MODE=dev is forbidden in production` | 忘了改 | `.env` 设 `AUTH_MODE=password` |
| API 起不来：`AUTH_JWT_SECRET ... required` | 缺密钥 | `openssl rand -hex 32` 填入 |
| API 起不来：`Knowledge embedding profile is required` | 缺 `EMBEDDING_*` | 三个变量一起填上（只是元数据） |
| Worker 报 `docker: command not found` / 权限拒绝 | `chatapp` 未在 docker 组或服务未重启 | `sudo usermod -aG docker chatapp && sudo systemctl restart chat-worker` |
| 聊天不出字、最后一次性刷出 | Nginx 缓冲了 SSE | 确认 `proxy_buffering off` 与长 `proxy_read_timeout` 生效 |
| 上传/下载 `SignatureDoesNotMatch` | 预签名 Host 与 Nginx 转发的不一致 | MinIO 段必须 `proxy_set_header Host $http_host;`，且 `S3_PUBLIC_ENDPOINT` 与访问地址完全一致 |
| `pnpm install` 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | 非 TTY 下 pnpm 拒绝重建 node_modules | `CI=true pnpm install --frozen-lockfile` |
| 沙箱命令返回 124 | 单条命令超时 | 调整 `DOCKER_SANDBOX_COMMAND_TIMEOUT_MS`（上限 600000） |
| 磁盘逐渐满 | 会话目录 + 容器日志 | 上 §12 的清理 cron；确认 Docker `log-opts` 已生效 |

---

## 附：文件清单

```
deploy/
├── README.md                        # 本文件
├── compose.infra.yaml               # Postgres / Redis / MinIO
├── env.production.example           # 生产 .env 模板
├── nginx/chat.conf                  # 主站 + MinIO 反代（含 SSE 配置）
├── systemd/
│   ├── chat-api.service
│   ├── chat-worker.service          # SupplementaryGroups=docker
│   └── chat-web.service
├── sandbox/Dockerfile.mirror        # 沙箱镜像国内加速变体（可选）
└── scripts/
    ├── host-setup.sh                # 宿主机初始化
    ├── app-build.sh                 # 构建 + 发布
    └── cleanup-sandboxes.sh         # 会话目录清理（cron）
```



基础设施全上 Docker。这和我生成的配置一致——Postgres/Redis/MinIO/Qdrant 走 Docker Compose，应用走 systemd。让我确认一下 infra compose 的端口映射是否和 .env 对应。
用户补充说整个项目包括数据库、Docker 都会部署到 xxx.xxx.xxx.xxx 上，所有数据库相关的都部署到 Docker 上。

这和现有的部署架构是一致的——基础设施（Postgres、Redis、MinIO、Qdrant）都用 Docker Compose 部署，应用（Web、API、Worker、Knowledge-service）用 systemd 部署在宿主机上。

我刚才生成的配置已经是这个架构了。让我确认一下 compose.infra.yaml 看看数据库配置是否正确。

端口映射完全对应。让我确认构建脚本是否包含 knowledge-service。
compose.infra.yaml 的端口映射和我的 .env 配置完全对应：
- Postgres: 127.0.0.1:55432 → DATABASE_URL 用 55432 ✓
- Redis: 127.0.0.1:56379 → REDIS_URL 用 56379 ✓
- MinIO: 127.0.0.1:59000 → S3_ENDPOINT 用 59000 ✓
- Qdrant: 127.0.0.1:56333 (compose.qdrant.yaml) → QDRANT_URL 用 56333 ✓

所有数据库/中间件都在 Docker 里，只绑定 127.0.0.1，不暴露公网。应用通过 systemd 跑在宿主机上，通过 127.0.0.1 访问这些服务。

现在让我更新 todo list 并给用户一个完整的总结。

我还需要提醒用户：
1. 密钥需要替换（REPLACE_* 的部分）
2. knowledge-service 需要构建（pnpm build 会构建所有包）
3. 启动 Qdrant 需要叠加 compose.qdrant.yaml
4. systemd 配置需要安装并启动

让我检查 app-build.sh 是否会构建 knowledge-service。

构建脚本会 `pnpm build` 全部包，但只装了 3 个 systemd unit，漏了 knowledge-service。我来补上。
`app-build.sh` 会执行 `pnpm build`，这会构建所有 workspace 包，包括 knowledge-service。但它只安装了 chat-api、chat-worker、chat-web 三个 systemd unit，没有 chat-knowledge。我需要更新这个脚本，把 chat-knowledge.service 也加进去。

让我更新 app-build.sh。

配置全部生成完毕。以下是完整方案：

## 生成的文件

| 文件 | 用途 |
|------|------|
| [deploy/env.keen-tech.top](file:///Users/keen/Desktop/code/projects/chat/deploy/env.keen-tech.top) | 线上 .env 配置 |
| [deploy/nginx/chat.keen-tech.top.conf](file:///Users/keen/Desktop/code/projects/chat/deploy/nginx/chat.keen-tech.top.conf) | Nginx 配置 |
| [deploy/systemd/chat-knowledge.service](file:///Users/keen/Desktop/code/projects/chat/deploy/systemd/chat-knowledge.service) | knowledge-service systemd |

## 架构总览

```
公网用户
  │
  ▼
chat.keen-tech.top:443 (Nginx)
  ├─ /          → Next.js Web (3020)
  ├─ /api/*     → API 直连 (8002)        ← SSE 流式少一跳
  └─ /knowledge → Next.js Web (3020)
  │
chat.keen-tech.top:9443 (Nginx)
  └─ /*         → MinIO (59000)          ← 预签名直传/下载
  │
  ──────────── 127.0.0.1 内网 ────────────
  │
  ├─ Postgres (55432)    ┐
  ├─ Redis (56379)       │  Docker Compose
  ├─ MinIO (59000)       │
  └─ Qdrant (56333)      ┘
  │
  ├─ chat-web.service      (systemd)
  ├─ chat-api.service      (systemd)
  ├─ chat-worker.service   (systemd, 需 docker.sock)
  └─ chat-knowledge.service (systemd)
```

## 部署步骤

### 1. 上传代码到服务器

```bash
rsync -av --delete \
  --exclude node_modules --exclude .next --exclude dist --exclude .turbo \
  --exclude .git --exclude data \
  ./ chatapp@xxx.xxx.xxx.xxx:/opt/chat/
```

### 2. 复制并填写 .env

```bash
cd /opt/chat
cp deploy/env.keen-tech.top .env
chmod 600 .env
```

**必须替换的密钥**（在服务器上生成）：
```bash
openssl rand -hex 32   # → AUTH_JWT_SECRET
openssl rand -hex 16   # → POSTGRES_PASSWORD（同时填 DATABASE_URL 和 POSTGRES_PASSWORD）
openssl rand -hex 16   # → MINIO_ROOT_PASSWORD
openssl rand -hex 32   # → KNOWLEDGE_MCP_SECRET 和 KNOWLEDGE_TOKEN_SECRET（两个必须相同）
```

### 3. 启动基础设施（含 Qdrant）

```bash
docker compose -f deploy/compose.infra.yaml -f deploy/compose.qdrant.yaml --env-file .env up -d --wait
```

### 4. 初始化数据库

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed    # 建 admin/owner/user 三个默认账号
```

### 5. 构建并启动应用

```bash
bash deploy/scripts/app-build.sh
```

### 6. 配置 Nginx + HTTPS

```bash
sudo cp /opt/chat/deploy/nginx/chat.keen-tech.top.conf /etc/nginx/conf.d/chat.conf
sudo certbot --nginx -d chat.keen-tech.top
sudo nginx -t && sudo systemctl reload nginx
```

## 安全组放行

| 端口 | 用途 | 来源 |
|------|------|------|
| 22 | SSH | 你的 IP |
| 80 | HTTP→HTTPS 跳转 | 0.0.0.0/0 |
| 443 | Web + API | 0.0.0.0/0 |
| 9443 | MinIO 预签名 | 0.0.0.0/0 |

**不要**开放 3020/8002/55432/56379/59000/56333/8090，这些都绑在 127.0.0.1。

## 验证

```bash
# 服务状态
systemctl status chat-api chat-worker chat-web chat-knowledge --no-pager

# 健康检查
curl -s http://127.0.0.1:8002/health/ready
curl -s http://127.0.0.1:8090/healthz

# 外网
curl -I https://chat.keen-tech.top/
```


需要区分几个 `.env` 文件，它们的用途不同：

## 三个 .env 文件的区别

| 文件 | 用途 | 需要改吗 |
|------|------|---------|
| 根目录 `.env` | **本地开发**用（端口 8002/3020、本地数据库等） | ❌ 不用改，本地开发继续用 |
| `.env.example` | **模板**，提交到 git 给别人参考 | ❌ 不用改（除非加新变量） |
| `deploy/env.keen-tech.top` | **线上配置模板**，我刚生成的 | ✅ 复制到服务器后替换密钥 |

## 关键点：rsync 时要排除本地 .env

你本地的 `.env` 是开发配置，如果直接 rsync 到服务器会覆盖线上配置。让我确认一下排除规则。
用户问的是：部署上线时，根目录的 `.env` 文件需要管吗？需要改吗？

这里有几个 `.env` 文件需要区分：
1. 本地开发用的 `.env`（在项目根目录，当前用户正在用的）
2. 线上用的 `.env`（部署到服务器 `/opt/chat/.env`）
3. `.env.example`（模板，提交到 git）

用户当前打开的是 `.env.example`。

关键问题是：根目录的 `.env`（本地开发用的）会不会被 rsync 传到线上？或者线上的 `.env` 是怎么来的？

从之前的部署步骤看：
- rsync 上传代码时，应该排除 `.env`（因为本地的 `.env` 是开发配置，端口、密钥等都不一样）
- 线上应该用 `deploy/env.keen-tech.top` 复制成 `/opt/chat/.env`

所以答案是：
1. **本地根目录的 `.env`**：不需要改，它是本地开发用的。rsync 时要排除它。
2. **线上 `/opt/chat/.env`**：需要用 `deploy/env.keen-tech.top` 复制过去，然后替换密钥。
3. **`.env.example`**：是模板，不需要改（除非有新的变量要加）。

让我检查一下 rsync 命令是否排除了 .env。从之前给的部署步骤看，rsync 排除了 node_modules, .next, dist, .turbo, .git, data，但没有排除 .env。这是个问题——本地的 .env 会被传到线上，覆盖线上的配置。

我需要提醒用户在 rsync 时排除 .env，或者在部署步骤中明确说明。

让我检查一下 .gitignore 是否排除了 .env。

`.env` 已经在 `.gitignore` 里了，不会被提交到 git。但 rsync 不会自动读 .gitignore，需要手动排除。

我之前给的 rsync 命令没有排除 .env，这是个问题。我需要更新部署步骤，在 rsync 时加上 `--exclude .env`。

让我给用户一个清晰的回答：
1. 本地 `.env` 不用改
2. 线上用 `deploy/env.keen-tech.top` 复制成 `/opt/chat/.env`
3. rsync 时要排除 `.env`，避免本地配置覆盖线上

我应该更新之前给的 rsync 命令。
`.env` 已在 `.gitignore` 中，不会进 git。但 **rsync 不会读 .gitignore**，需要手动排除。

## 回答你的问题

**根目录的 `.env` 不用管、不用改**，它是你本地开发用的。线上用的是单独的 `/opt/chat/.env`。

但有一个坑：之前给的 rsync 命令**没有排除 `.env`**，本地的开发配置会被传到服务器覆盖线上配置。需要加上 `--exclude .env`。

## 修正后的上传命令

```bash
rsync -av --delete \
  --exclude .env \
  --exclude node_modules --exclude .next --exclude dist --exclude .turbo \
  --exclude .git --exclude data \
  ./ chatapp@xxx.xxx.xxx.xxx:/opt/chat/
```

## 线上 .env 的正确放置方式

```bash
# 在服务器上
cd /opt/chat
cp deploy/env.keen-tech.top .env   # 从模板复制
chmod 600 .env
# 然后替换里面的 REPLACE_* 密钥
```

**不要**把本地的 `.env` 直接传上去，因为：
- 本地 `API_PORT=8002` 虽然端口一样，但 `WEB_ORIGIN=http://localhost:3020` 线上必须是 `https://chat.keen-tech.top`
- 本地密钥（JWT、数据库密码、MinIO 密码）线上必须重新生成
- 本地 `AUTH_SIGNUP_ENABLED=true` 线上应该是 `false`

所以总结：**本地 `.env` 不动，线上用 `deploy/env.keen-tech.top` 复制后填密钥**。