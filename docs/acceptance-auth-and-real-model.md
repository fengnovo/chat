# 真实模型、登录与端到端验收指南

## 先说结论

| 能力                               | 当前状态        | 说明                                                                                                |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| Web → API → Queue → Worker → SSE | 已完成         | 会话、持久化事件、队列、Worker 和断点续传链路已实现                                                               |
| 连接真实大模型                          | 已接通，需用户密钥验收 | Worker 固定使用 `deep` driver；支持 OpenAI、Anthropic 和 OpenAI-compatible endpoint                         |
| API 多租户隔离                        | 已实现基础能力     | JWT 中的可信 `tenant_id` 决定数据范围，Repository 查询强制带 tenant                                               |
| API OIDC/JWT 校验                  | 已实现         | 校验签名、issuer、audience、过期时间、`sub` 和 `tenant_id`                                                     |
| Web 登录页与会话                       | 尚未实现        | 当前 Web 不会登录，也不会向 API 注入 Bearer Token                                                              |
| Web 会话管理                         | 已完成         | 新建会话会立即创建独立 session/thread/workspace；支持历史恢复、切换、重命名、软删除和游标分页                                       |
| 角色级 RBAC                         | 尚未完整实现      | 能解析 `owner/admin/member`，但业务路由还没有细分角色权限                                                           |
| 会话工作区                            | 已完成         | 新建会话直接创建独立空白 workspace；Web 不再要求选择项目、Git 仓库或本地目录                                             |
| 开发/测试数据隔离                        | 已完成         | 本地开发使用 `agent` 数据库，集成测试使用独立端口和卷中的 `agent_test` 数据库                                                |
| Sandbox                          | 配置已接入       | 开发默认连接本机 E2B-compatible Docker endpoint；生产默认连接 E2B Cloud；本机端点需单独验收                  |

因此，“能否和真实模型聊天、恢复历史并让 Agent 在会话的空白 workspace 工作”的答案是可以；“能否作为完整的多租户生产 Coding Agent 上线”的答案仍然是还不可以。当前缺少的关键产品链路是 Web 登录、Token 传递、资源配额，以及与 Sandbox 脱钩的 workspace 持久化。

## 为什么本地页面不要求登录

本地配置默认是：

```dotenv
AUTH_MODE=dev
DEV_TENANT_ID=00000000-0000-4000-8000-000000000001
DEV_USER_ID=00000000-0000-4000-8000-000000000001
```

在该模式下，API 会为每个请求注入同一个固定身份：

```text
tenantId = DEV_TENANT_ID
userId   = DEV_USER_ID
roles    = [owner]
```

这个模式的用途是无需身份供应商即可验收队列、SSE、审批和 Worker，不是生产登录方案。

保护措施：当 `NODE_ENV=production` 且 `AUTH_MODE=dev` 时，API 会拒绝启动。切换到 `AUTH_MODE=oidc` 后，没有合法 `Authorization: Bearer <JWT>` 的 API 请求会返回 `401`。

不过，当前 Web 尚未实现以下部分：

1. `/login` 页面或外部身份供应商跳转。
2. 登录回调和服务端 Session/Cookie。
3. 获取 access token。
4. 在 Web 的聊天、SSE、审批、取消请求中携带 Bearer Token。
5. tenant 切换和角色级 UI。

所以现在直接把 API 切到 OIDC，API 会变安全，但 Web 会因为没有 Token 而收到 `401`。这是当前明确的未完成项。

## 一、本地基础环境验收

要求：Node.js 22+、pnpm 11+、Docker。

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm db:migrate:test
pnpm dev
```

根目录 `.env` 会传给 Web、API、Worker、CLI 和 migration。不要提交 `.env`，它已被 `.gitignore` 忽略。

检查服务：

```bash
curl -fsS http://127.0.0.1:8000/health/live
curl -fsS http://127.0.0.1:8000/health/ready
docker compose -f infra/compose.yaml ps
```

预期结果：

- `health/live` 返回 `{"status":"ok"}`。
- `health/ready` 返回 `{"status":"ready"}`。
- Postgres、Redis、MinIO 均为 `healthy`。
- Worker 日志显示 `Agent worker ready: driver=deep, sandbox=local-e2b`。

## 二、默认全链路验收

1. 打开 <http://localhost:3000>。
2. 点击“新建对话”，确认不再弹出项目选择窗口，并立即创建一条带独立空白 workspace 的会话。
3. 确认新会话立即出现在左侧；输入消息后观察运行轨迹从 queued/running 进入 completed。
4. 切换到另一条会话再切回来，确认用户消息和 Agent 回复都能恢复，且只显示一个 `Coding Agent`。
5. 使用会话右侧菜单验收重命名和删除；历史超过一页时点击“加载更多”。
6. 刷新页面，确认已完成内容仍存在，并且没有创建第二个 Run。

查询持久化证据：

```bash
docker compose -f infra/compose.yaml exec -T postgres \
  psql -U agent -d agent -c \
  "SELECT id, status, last_event_seq, created_at FROM agent_runs ORDER BY created_at DESC LIMIT 5;"

docker compose -f infra/compose.yaml exec -T postgres \
  psql -U agent -d agent -c \
  "SELECT event_type, seq FROM run_events WHERE run_id = (SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT 1) ORDER BY seq;"

docker compose -f infra/compose.yaml exec -T postgres \
  psql -U agent -d agent -c \
  "SELECT attempts, published_at IS NOT NULL AS published, consumed_at IS NOT NULL AS consumed FROM run_dispatch_outbox ORDER BY created_at DESC LIMIT 5;"
```

通过标准：最新 Run 为 `completed`，事件 seq 单调递增，Outbox 的 `published` 和 `consumed` 都为 `true`。

### 集成测试数据隔离

`pnpm infra:up` 会同时启动开发库 `127.0.0.1:55432/agent` 和测试库 `127.0.0.1:55433/agent_test`。运行：

```bash
pnpm test:integration
```

脚本会把 `DATABASE_URL` 明确指向 `agent_test`；测试代码还会校验数据库名必须包含 `test`，防止误清理开发数据。普通 `pnpm test` 不会向开发库写测试会话。

## 三、真实大模型验收

当前代码不能替你验证真实模型，因为仓库中不应保存真实 API Key。需要使用你自己的 provider 凭据。

### OpenAI 或 OpenAI-compatible endpoint

编辑根目录 `.env`：

```dotenv
AUTH_MODE=dev
AGENT_DRIVER=deep
MODEL=openai:<你的模型ID>
OPENAI_API_KEY=<你的API Key>
OPENAI_BASE_URL=https://api.openai.com/v1
```

如果使用兼容 OpenAI API 的服务，将 `OPENAI_BASE_URL` 和模型 ID 换成该服务提供的值。

### Anthropic

```dotenv
AUTH_MODE=dev
AGENT_DRIVER=deep
MODEL=anthropic:<你的模型ID>
ANTHROPIC_API_KEY=<你的API Key>
```

### Fallback 示例

```dotenv
MODEL=openai:<primary-model-id>
OPENAI_API_KEY=<OpenAI Key>
FALLBACK_MODELS=anthropic:<fallback-model-id>
ANTHROPIC_API_KEY=<Anthropic Key>
```

修改后必须重启 Worker；最简单的方式是停止并重新执行：

```bash
pnpm dev
```

Worker 日志必须显示：

```text
Agent worker ready: driver=deep
```

在页面发送：

```text
请只回复 REAL_MODEL_OK，不要修改文件，也不要运行命令。
```

通过标准：

- 页面收到模型生成内容。
- Run 最终为 `completed`。
- 不出现 `Missing API key`、`401`、模型不存在或 provider 加载失败。
- 模型发生可恢复故障时，轨迹可出现 `model.retry`；主模型失败并使用备用模型时出现 `model.fallback`。

如果 Run 为 `failed`，先查：

```bash
docker compose -f infra/compose.yaml exec -T postgres \
  psql -U agent -d agent -c \
  "SELECT status, error_code, error_message FROM agent_runs ORDER BY created_at DESC LIMIT 1;"
```

## 四、真实 Coding Agent 与审批恢复验收

真实模型模式下发送：

```text
请在当前 workspace 创建 hello.txt，内容为 REAL_AGENT_FILE_OK，然后读取它确认内容。
```

预期流程：

1. Agent 规划任务并请求文件写入审批。
2. Web 显示审批卡片，Run 进入 `waiting_approval`。
3. 等待期间 Worker 已释放，不长期占用执行槽。
4. 点击批准后，API 原子解决 interrupt 并写入 resume outbox。
5. Worker 从 PostgreSQL checkpoint 恢复，而不是重新开始整个任务。
6. Run 最终进入 `completed`，文件存在于该 Session 的 workspace。

查找最新 workspace：

```bash
docker compose -f infra/compose.yaml exec -T postgres \
  psql -U agent -d agent -Atc \
  "SELECT w.path FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=s.workspace_id ORDER BY r.created_at DESC LIMIT 1;"
```

注意：Web workspace 当前是新建的空目录，不会自动包含这个 monorepo。要让 Agent 修改真实用户仓库，还需要实现 Git 授权/clone、上传解包或模板初始化，并在 Sandbox 内完成 checkout。

## 五、SSE 续传和取消验收

### SSE 续传

1. 在真实模型模式提交一个耗时较长的任务。
2. 流式输出开始后刷新页面或暂时断网。
3. 恢复连接。
4. 检查页面是否从最后 cursor 继续，而不是重复创建 Run。

数据库通过标准：同一 `run_id` 只有一条 Run 记录，`run_events.seq` 无重复且连续递增。

也可以直接重放：

```bash
RUN_ID=<需要检查的Run UUID>
curl -N "http://127.0.0.1:8000/api/agent/runs/$RUN_ID/events?cursor=0"
curl -N "http://127.0.0.1:8000/api/agent/runs/$RUN_ID/events?cursor=10"
```

第二次请求只应返回 seq 大于 10 的事件。

### 取消

1. 提交一个正在生成或执行的任务。
2. 点击“停止生成”。
3. 确认页面收到 `run.cancelled`。
4. 查询 `agent_runs`，状态应为 `cancelled`，不能继续写入 completed 终态。

## 六、OIDC 和跨租户隔离验收

这一阶段目前只能从 API 验收；Web 登录集成完成后才能做浏览器验收。

配置：

```dotenv
AUTH_MODE=oidc
OIDC_ISSUER=https://<issuer>
OIDC_AUDIENCE=<audience>
OIDC_JWKS_URL=https://<issuer>/<jwks-path>
```

JWT 必须包含：

```json
{
  "sub": "内部用户UUID",
  "tenant_id": "内部租户UUID",
  "roles": ["owner"]
}
```

这里的 `sub` 和 `tenant_id` 必须是 UUID。很多身份供应商的原始 `sub` 不是 UUID，因此生产上通常需要身份网关或登录回调把外部 subject 映射成平台内部 user UUID。

准备两个 Token：

```bash
export TOKEN_A='<tenant A access token>'
export TOKEN_B='<tenant B access token>'
```

无 Token 必须失败：

```bash
curl -i http://127.0.0.1:8000/api/agent/sessions
```

预期为 `401`。

Tenant A 创建 Session：

```bash
SESSION_A=$(curl -fsS \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"title":"tenant-a-session"}' \
  http://127.0.0.1:8000/api/agent/sessions | jq -r .id)
```

Tenant B 尝试读取：

```bash
curl -i \
  -H "Authorization: Bearer $TOKEN_B" \
  "http://127.0.0.1:8000/api/agent/sessions/$SESSION_A"
```

通过标准：返回 `404`，不能返回 Tenant A 的任何字段。还应分别测试过期 Token、错误 audience、错误 issuer 和篡改签名，均应返回 `401`。

注意：目前 `roles` 只被解析并写入 membership，尚未实现“member 不能执行某操作”等细粒度 RBAC，因此角色权限不能算验收完成。

## 七、Artifact 对象存储验收

准备一个已存在的 Run UUID：

```bash
RUN_ID=<Run UUID>
printf 'ARTIFACT_OK\n' > /tmp/agent-artifact.txt
SIZE=$(wc -c < /tmp/agent-artifact.txt | tr -d ' ')
SHA=$(shasum -a 256 /tmp/agent-artifact.txt | awk '{print $1}')

CREATE=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"agent-artifact.txt\",\"contentType\":\"text/plain\",\"sizeBytes\":$SIZE,\"sha256\":\"$SHA\"}" \
  "http://127.0.0.1:8000/api/agent/runs/$RUN_ID/artifacts")

ARTIFACT_ID=$(printf '%s' "$CREATE" | jq -r .artifact.id)
UPLOAD_URL=$(printf '%s' "$CREATE" | jq -r .uploadUrl)

curl -fsS -X PUT \
  -H 'Content-Type: text/plain' \
  -H "x-amz-meta-sha256: $SHA" \
  --data-binary @/tmp/agent-artifact.txt \
  "$UPLOAD_URL"

curl -fsS -X POST \
  "http://127.0.0.1:8000/api/agent/artifacts/$ARTIFACT_ID/complete"

DOWNLOAD_URL=$(curl -fsS \
  "http://127.0.0.1:8000/api/agent/artifacts/$ARTIFACT_ID" | jq -r .downloadUrl)
curl -fsS "$DOWNLOAD_URL" -o /tmp/agent-artifact.downloaded.txt
cmp /tmp/agent-artifact.txt /tmp/agent-artifact.downloaded.txt
```

通过标准：`complete` 后 artifact 状态为 `ready`，下载文件完全一致，对象 key 位于 `tenants/<tenantId>/runs/<runId>/...` 下。

OIDC 模式下，上述 API 请求都要增加 `Authorization` header。

## 八、自动化回归与生产构建

```bash
pnpm typecheck
pnpm test
pnpm exec turbo run build --force
```

生产产物冒烟需要分别打开终端：

```bash
# 终端 A
API_PORT=8001 pnpm --filter @repo/agent-api start:prod

# 终端 B
pnpm --filter @repo/agent-worker start:prod

# 终端 C
curl -fsS http://127.0.0.1:8001/health/ready
```

## 九、建议的验收顺序

1. 先用 `deep + dev auth` 验收真实模型、审批、恢复和取消。
2. 再断线、刷新和重启 Worker，验收事件重放与 workspace 连续性。
3. 接入身份供应商后，用两个真实 tenant Token 做 API 隔离测试。
4. 实现 Web 登录和 Token 注入，再做浏览器多用户验收。
5. 完成 workspace snapshot/volume 持久化、Sandbox 资源限制和故障恢复验收。
6. 最后进行并发、限流、队列积压、Worker 崩溃、Redis 重启和对象存储故障测试。

在第 4、5 步完成之前，可以验收“多租户 Agent 平台纵切、持久化会话和空白 workspace 执行”，但不能宣称完成“多用户生产 Coding Agent”。

### E2B 沙箱接入

主要结果：

1. Worker 强制使用 `deep + E2B protocol`，拒绝 `demo` 和宿主机执行配置。
2. E2B 配置缺失时直接启动失败，不再回退宿主机执行。
3. Session/workspace 的 sandbox ID 持久化到 PostgreSQL。
4. start/resume 自动 create/connect sandbox。
5. 等待审批、等待回答或完成时 pause；失败、取消时 kill 并清除 sandbox ID。
6. Web 会话默认从 E2B 内的空目录开始，文件和命令操作全部在沙箱内执行。
7. E2B 前台命令已接入取消信号，取消时会终止远程进程。
8. CLI 同样强制使用 E2B，并将 skills、`AGENTS.md` 上传到远程沙箱。
9. CLI 界面改为显示真实 E2B 工作目录。
10. 删除 Demo Agent 实现。
11. 新增数据库迁移 007\_e2b\_workspace\_sandbox.sql 。
12. 核心适配器位于 e2b-sandbox.ts 。

开发环境会把 E2B SDK 的控制面和 sandbox proxy 指向：

```dotenv
DEV_E2B_API_KEY=<本地控制面的密钥，可与云端相同时省略>
DEV_E2B_API_URL=http://localhost:10086
DEV_E2B_SANDBOX_URL=http://localhost:10086
```

生产环境不会使用这两个开发变量，仍走 E2B Cloud。若本地部署把控制面和 proxy
暴露在不同端口，应分别覆盖这两个值；本地服务必须兼容 E2B API，而不能只是普通
Web 页面或应用预览端口。
