# 移动端生产附件修复

## 2026-10-09 生产复核与本次交付

在 `emulator-5554` 已登录的 Android Release 0.1.0 上，通过系统文件选择器上传 `微信图片_20261008224750_250_12.jpg`，发送“这是什么？”，再次复现。APK SHA-256 为 `9bf25852f676ee6abd83bcca6ac1c8a2a1bee231a7f449bc153c91d198148374`。

这次生产对照确认了两个独立问题：

| 检查 | 实际结果 | 修复 |
| --- | --- | --- |
| RN 与 H5 上传地址 | 都原样使用 API 返回的 `uploadUrl`；JPEG 的 PUT、complete 均为 200 | 保持现有上传协议 |
| 图片展示 | content 经 Bearer/Cookie 鉴权后均为 302；同一签名 GET 不带 Bearer 为 200、字节与原图一致，带 Bearer 为 400 `multiple authentication types` | content 鉴权后直接流式返回私有图片，取消下载重定向 |
| RN 创建任务 | 明确提交已就绪的 `attachmentIds`，返回 202，但 history 用户消息没有附件 | runs 接口校验并传递附件引用 |
| H5 创建任务 | 同一附件经 `/api/chat` 的 `attachment_ids` 提交后，history 有 `kind=image`、`image/jpeg`；任务 completed，正确识别 `Unable to load script` 红屏 | 证明图片对象和模型视觉链路可用 |

实际 UI 复现会话：`3f12aca6-75cb-42cc-b715-a86019e5da61`，run `30ffb06b-daab-4058-99fc-24be5a3736f1`。显式 RN API 对照会话：`5a3a8743-8048-401e-8433-3b011a69ca0d`，run `43d83765-f35a-4ed0-9352-6a6f55df22b9`。H5 API 对照会话：`9cf53cf6-1a4f-468a-87f8-37f32329f4a5`，run `febd80b4-1e5a-4338-9553-a47e445bdbcb`。两个失败测试任务已取消，测试会话保留。

本地验证：当前工作区 7 项附件/移动端 API 回归通过；真实 PostgreSQL、MinIO、HTTP 集成用同一 JPEG 验证 Bearer/Cookie 200、855864 字节完全一致、无登录 401、他人/跨租户 404、pending 409、匿名对象存储 403。另在旧提交 `e4660b0` 的隔离副本中确认两项核心回归先失败（302、附件为 undefined），只应用本目录的两份补丁后，5 项相关回归全部通过。API、contracts、artifacts 类型检查及生产构建均通过。

截图、控件树和脱敏接口结果保存在 `node_modules/.cache/mobile/image-production-recheck/`。生产运行构建的确切提交未通过 SSH 核实；用户自行部署、验收，本次没有更改生产服务或 Nginx。

### 用户上线与验证步骤

1. 将 `mobile-attachments.patch`、`mobile-private-content.patch` 复制到服务器 `/tmp/`。在 `chat-api` 的实际工作目录内，按下文先备份源码和构建产物，再分别 `git apply --check`、`git apply`。如果某项修复源码已存在，跳过该补丁；不要强行覆盖。当前工作区已经包含两项修复，也不要再次应用补丁。
2. **构建三个包后再重启 API**，构建与重启必须使用现有部署用户和方式：

   ```bash
   pnpm --filter @repo/contracts build &&
   pnpm --filter @repo/artifacts build &&
   pnpm --filter @repo/agent-api build &&
   sudo systemctl restart chat-api
   curl -fsS http://127.0.0.1:8002/health/ready
   ```

   这两项修复不需要数据库迁移、Worker 重启、Nginx 修改或重新打 APK。不要把包含其他未提交功能的整个工作区直接同步上线。
3. 使用当前 Release 包**新建会话、重新上传**上述 JPG，只发送“这是什么？”。预期：缩略图加载成功；点开大图正常；AI 识别出 React Native 红屏和 `Unable to load script`。旧失败任务不会自动补回附件。
4. 返回列表重开该会话，再冷启动 App 重开；图片与回答应仍存在。H5 打开同一会话应一致。
5. 请求新会话的 `/api/agent/sessions/<sessionId>/history`：用户消息应含 `attachments`，其中 `kind=image`、`contentType=image/jpeg`，`latestRun.status=completed`。
6. 对该附件的 `/api/agent/chat-attachments/<attachmentId>/content` 验证：本人 Bearer 或 Cookie 返回 **200 图片字节**、`Cache-Control: private, no-store`、**无 Location/302**；无登录环境打开同一 content URL 返回 **401**；另一个用户或租户返回 **404**。整个验证保留 Bearer，不设置匿名桶权限。

下方保留两份补丁各自的部署、回滚说明和本地复跑命令。

症状：Android Release 直传图片显示绿色已上传，用户气泡显示附件，AI 却只收到文字。生产任务 `1c39c09a-3097-4b96-9d84-a51e0c42c716` 的 history 没有 attachments。当前 APK 包含 body.attachmentIds；生产响应行为与 a402566 之前的移动端接口一致，生产运行版本仍需 SSH 核实。

`mobile-attachments.patch` 从 a402566 提取，仅修改两处：

- contracts 的 createRunSchema 保留、校验 attachmentIds。
- API 的原生 runs 接口校验本人可用附件，传给 repository.createRun。

不包含移动端构建、其他未提交的功能、数据库迁移或 Worker 改动。现有 repository / Worker 的 Web 附件链路已经支持这些引用。旧接口返回 202 但传给 repository 的 attachments 为 undefined；应用补丁后，同一个 JPEG 请求携带完整图像引用，无效附件返回 400。补丁应用及前后回归日志见 `node_modules/.cache/mobile/e2e-2026-10-09/release-fix/`。

## 生产核实与执行

取得 SSH 后先检查 systemctl cat chat-api 的实际工作路径、ExecStart，以及运行构建是否包含 attachmentIds、getReadyChatAttachments、attachments 的原生 runs 分支。API 和 contracts 是两个独立构建产物；只更新源码或只重启服务都不保证修复生效。

将本补丁复制到服务器 `/tmp/mobile-attachments.patch` 后，在实际仓库根（文档默认 `/opt/chat`）执行：

```bash
git apply --check /tmp/mobile-attachments.patch
```

若检查失败，先比较生产文件，不要强行覆盖或再次应用已经存在的源码修复。若源码已有修复而 dist 没有，应直接备份构建产物并重新构建。

应用前备份两份源码、`apps/api/dist`、`packages/contracts/dist`，记录 chat-api 启动方式和进程。按原有构建用户执行：

```bash
git apply /tmp/mobile-attachments.patch
pnpm --filter @repo/contracts build
pnpm --filter @repo/agent-api build
node --input-type=module -e 'import {createRunSchema} from "./packages/contracts/dist/index.js"; const id="33333333-3333-4333-8333-333333333333"; if(createRunSchema.parse({message:"image test",attachmentIds:[id]}).attachmentIds?.[0]!==id) process.exit(1); console.log("built contract preserves attachmentIds")'
systemctl restart chat-api
curl -fsS http://127.0.0.1:8002/health/ready
```

不需要重启正在执行模型任务的 Worker。构建失败不得重启；重启后 readiness 失败应恢复两组 dist 和源码备份，再按原启动方式启动 API。

## 验收

1. 已登录的同一 Android Release APK，新建会话。
2. 系统选择器上传用户指定 JPEG；只问“这是什么”。
3. 上传绿色、发送、收到真正识别截图的回答。
4. 生产 history 用户消息有 kind=image、image/jpeg 和对应 attachmentId；任务 completed。
5. 返回列表重开及冷启动后仍有图片和回答；Web 打开同一会话结果一致。

已有失败任务不会因更新接口自动补回图片；必须重新上传发送。保留原失败对话作为证据。

## RN 图片下载：保留鉴权，由 API 返回私有内容

两端 PUT 都直接使用服务端 uploadUrl，没有分别拼接 host 或文件名。旧读图接口鉴权后 302 到预签名 GET；RN 同源跳转保留 Bearer，MinIO 同时收到 Bearer 与查询签名而返回 400。H5 Cookie 没有这项冲突。它是图片展示故障，与前面的 run 附件转交缺失分别修复。

此前建议在 Nginx 对象存储转发处剥离 Bearer，现已撤回：用户要求下载资源始终校验登录及归属。预签名下载 URL 本身就是临时授权，得到完整链接的人可以在有效期内读取。两份 Nginx 模板已恢复；不要应用此前的 map／Authorization 清空配置。生产尚未部署这些改动。

采用 `mobile-private-content.patch`：content API 保留原有 Bearer／Cookie 鉴权以及 tenant_id + user_id 归属查询，校验 ready 后经内部 S3 客户端流式读取，直接返回 200 图片字节。不返回 Location 或预签名下载 URL，设置 private, no-store 和 nosniff。其他文件强制作为下载，保留存储的 Content-Encoding 和实际 Content-Length，避免 gzip 文本损坏以及 HTML 在 API 同源执行。

上传仍使用限制对象、方法及有效期的预签名 PUT，PUT URL 不能改成 GET 读取文件。MinIO 桶不开放匿名读取。Worker 仍按 objectKey 取内部字节。既有其他资源的预签名下载入口不在本附件修复范围内。

### 核实与部署

先检查生产 content 路由和 artifacts 包是否已有 getObjectStream；备份 `apps/api/src/routes.ts`、`packages/artifacts/src/index.ts` 及两包 dist，按原构建用户执行：

```bash
git apply --check /tmp/mobile-private-content.patch
git apply /tmp/mobile-private-content.patch
pnpm --filter @repo/artifacts build
pnpm --filter @repo/agent-api build
systemctl restart chat-api
curl -fsS http://127.0.0.1:8002/health/ready
```

若同时应用原生 run 附件补丁，先构建 contracts，再 artifacts，最后 API。构建失败不得重启；readiness 失败恢复备份。无需修改 Nginx、数据库迁移或重启 Worker。不要同步整个包含其他未提交改动的工作区。

### 本地验证及上线验收

API 的 4 项新回归使用实际 buildApp 鉴权：Bearer／Cookie 图片直接返回、无登录／无效 JWT 为 401、其他用户／租户为 404、pending 为 409、gzip 文本可还原且作为下载。外部存储和数据库在这些单测中是替身。

另用真实 HTTP、PostgreSQL 和 MinIO 上传用户指定的 JPEG，complete 后 Bearer 与 Cookie 均得到逐字节一致的 855864 字节，未重定向；复制 content URL 无登录为 401、他人／跨租户为 404、直接匿名读 MinIO 为 403。集成脚本只允许回环地址，创建和清理自己的测试身份／附件／对象，不处理已有任务；它不是原生 UI E2E。

```bash
cd apps/api
node --env-file=../../.env --conditions=development --import tsx scripts/test-private-chat-images.ts ../微信图片_20261008224750_250_12.jpg
node --conditions=development --import tsx --test test/chat-attachment-content.test.ts test/mobile-run.test.ts
```

生产上线后，同一已登录 Release 上传此图，分别确认缩略图／大图、AI 读图、history 附件持久化和 H5 同会话；复制 content URL 到无登录环境必须 401。真实生产通过仍待部署和 UI 重测。
