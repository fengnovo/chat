# Web 登录 + 多租户 RBAC（文档三角色）+ 知识库授权 实施计划

工作目录：`/Users/keen/Desktop/code/projects/chat/.worktrees/knowledge-graphrag-mvp`（以下路径均相对此目录）

## Context

README 规划的多租户平台目前 API 侧已有 dev/OIDC 双模式认证与 `tenants/users/tenant_memberships` 表，但 Web 无登录页、业务路由没有细分角色权限（docs/acceptance-auth-and-real-model.md L13、L303 明确标注的未完成项）。本次补齐：本地账号密码登录（API 签发 JWT httpOnly cookie，经 Next.js 同源代理自动携带）、真实租户身份、按文档既定 **owner/admin/member 三角色** 实现细粒度 RBAC、admin 管理用户并把知识库授权给用户在聊天中使用 RAG。

**角色模型（与 docs/acceptance-auth-and-real-model.md、migration 001 CHECK 完全一致，不做角色迁移）：**
- **admin**（超级管理员）：管理本租户所有知识库（增删改查）、用户管理（创建/改角色/重置密码）、给用户授权知识库。
- **owner**（知识库拥有者角色）：可创建知识库并管理自己的库（`knowledge_bases.owner_user_id`）；不能管理他人私有库。
- **member**（普通用户，即需求中的 user）：仅聊天；使用被授权的库 + `visibility='tenant'` 的库。
- JWT `roles` 契约不变（owner/admin/member 原样解析），dev 模式 `roles=['owner']` 不变。
- **可读/可用于 RAG** = `visibility='tenant'` OR 我是 owner_user_id OR admin OR 被授权（新表 `knowledge_base_grants`）。
- **可写** = 我是 owner_user_id OR admin。**建库** = 全局角色为 owner 或 admin。
- 与旧代码的差异点：旧谓词 `$roles && ARRAY['owner','admin']` 会让角色 owner 拥有全租户库写权限，新谓词把角色 owner 收敛为"仅自己的库"。

## Phase 1 — packages/db

1. **新增 `src/password.ts`**：`hashPassword`/`verifyPassword`（node:crypto scrypt，格式 `scrypt$<saltHex>$<hashHex>`，timingSafeEqual），从 `src/index.ts` 导出。
2. **新增 `migrations/010_password_auth_and_kb_grants.sql`**（沿用 NNN_name.sql 模式，**不改 tenant_memberships**）：
   ```sql
   ALTER TABLE users ADD COLUMN username text UNIQUE;   -- 可空：ensureIdentity（repository.ts:221-240）每次请求 upsert 不带 username
   ALTER TABLE users ADD COLUMN password_hash text;
   CREATE TABLE knowledge_base_grants (
     id uuid PRIMARY KEY,
     tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     kb_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     granted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX knowledge_base_grants_kb_user_idx ON knowledge_base_grants (kb_id, user_id);
   CREATE INDEX knowledge_base_grants_tenant_user_idx ON knowledge_base_grants (tenant_id, user_id);
   ```
3. **`src/schema.ts`**：users 加 `username`/`passwordHash`；新增 `knowledgeBaseGrants` 表定义。
4. **`src/knowledge-repository.ts` 谓词替换**（所有 `ARRAY['owner','admin']` 处）：
   - 读/可用（L32 list、L37 get、L59/64 documents）：
     `(visibility='tenant' OR owner_user_id=$me OR EXISTS(SELECT 1 FROM knowledge_base_grants g WHERE g.kb_id=k.id AND g.user_id=$me AND g.tenant_id=$tenant) OR $roles && ARRAY['admin']::text[])`
   - 写（L42 canWrite、L54 delete、L69 upload、L79 confirm、L91 deleteDocument）：`(owner_user_id=$me OR $roles && ARRAY['admin']::text[])`
   - `createKnowledgeBase`（L46）加角色校验：`auth.roles` 含 `owner` 或 `admin` 才允许（或在路由层 requireRole）。
5. **`src/repository.ts`**：
   - `createRun`（L543-553）KB 可见性校验换成上述"可读/可用"谓词（grants + admin，去掉 owner 角色直通）。
   - 新增方法：`findUserForLogin(username)`（JOIN tenant_memberships，取最早 membership）、`listTenantUsers(tenantId)`（含 role、grantedKbCount）、`createTenantUser`（23505 → 新增 `RepositoryConflictError`）、`updateTenantUser(role/displayName/passwordHash)`、`getUserDisplayName`、`listKnowledgeBaseGrants`、`replaceKnowledgeBaseGrants`（事务内校验 kbIds 属本租户且未删除，否则 `RepositoryNotFoundError('knowledge_base')`，再 DELETE+INSERT）。`ensureIdentity` 不变（roles[0] 仍为 owner/admin/member）。
6. **新增 `src/seed.ts`**（幂等，ON CONFLICT DO UPDATE）：租户 `00000000-...-0001`（= DEV_TENANT_ID）；账号：`admin/admin123`（admin）、`owner/owner123`（owner，知识库拥有者演示）、`user/user123`（member）。`packages/db/package.json` 加 `seed` 脚本（对齐 migrate 脚本 tsx/env-file 模式），根 `package.json` 加 `db:seed`。

## Phase 2 — apps/api

1. **`src/config.ts`**：`AUTH_MODE: z.enum(['dev','password','oidc']).default('dev')`（默认保持 dev，`test/config.test.ts:11` 依赖）；新增 `AUTH_JWT_SECRET`（min 32，password 模式必填 superRefine）。
2. **`src/auth.ts`**（现有 dev/oidc 分支逻辑不动）：
   - 常量 `SESSION_COOKIE_NAME='agent_session'`、TTL 7 天。
   - `createAuthenticator` 加 `password` 分支：cookie（或 Bearer 回退）取 JWT → `jose jwtVerify` HS256 → sub/tenant_id UUID 校验 → **查 DB** `SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`（注入 `loadMembership` 回调，缺行=401，改角色/删用户即时生效）→ `roles:[role]`。`rolesOf` 保持 owner/admin/member 原样。
   - 新增导出：`signSessionToken`（HS256 SignJWT，payload `{sub, tenant_id, roles:[role]}`）、`class ForbiddenError (403)`、`requireAdmin(auth)`（roles 含 admin，否则 throw ForbiddenError）。
3. **`src/app.ts`**：
   - `await app.register(cookie)`（新增依赖 `@fastify/cookie@^11`，Fastify 5）。
   - preHandler（L85）顶部加公开路径跳过：`/api/auth/login`、`/api/auth/logout`（连同限流跳过；登录单独按 IP 限流 `rate:login:${ip}`）。
   - L87 改 `authenticate({authorization, cookie: request.headers.cookie})`。
   - setErrorHandler（L108）加 `ForbiddenError→403 {error:'forbidden'}`、`RepositoryConflictError→409 {error:'username_taken'}` 分支。
   - L129 后注册 `registerAuthRoutes`、`registerAdminRoutes`。
4. **新增 `src/auth-routes.ts`**（zod 内联，参考 knowledge-routes.ts）：
   - `POST /api/auth/login`：`findUserForLogin` + `verifyPassword`；失败 401 `invalid_credentials`；成功 `signSessionToken` + `reply.setCookie('agent_session', token, {httpOnly, sameSite:'lax', path:'/', secure: NODE_ENV==='production', maxAge})`，返回 `{user:{id,displayName,role,tenantId}}`。
   - `POST /api/auth/logout`：clearCookie（公开）。`GET /api/auth/me`：`{user:{id, displayName, role: auth.roles[0], tenantId}}`。
5. **新增 `src/admin-routes.ts`**（每个 handler 先 `requireAdmin(request.auth)`）：
   - `GET /api/admin/users`；`POST /api/admin/users {username(^[a-zA-Z0-9_.-]{3,64}$), displayName, password(min8), role:'admin'|'owner'|'member'}`；`PATCH /api/admin/users/:userId {role?, password?, displayName?}`。
   - `GET/PUT /api/admin/users/:userId/knowledge-bases`（PUT `{knowledgeBaseIds: uuid[]}`，RepositoryNotFoundError→404 按 routes.ts 映射模式）。全部以 `auth.tenantId` 收口。

## Phase 3 — apps/web

1. **`app/components/resilient-chat/api.ts`**：新增 `apiFetch` 包装（401 且不在 `/login` 时 `window.location.assign('/login')`），现有 helpers 全走它；新增 `fetchCurrentUser`/`logout`/`listAdminUsers`/`createAdminUser`/`updateAdminUser`/`fetchUserKbGrants`/`replaceUserKbGrants`；`KnowledgeBase` 类型加 `owner_user_id?`（`SELECT *` 返回 snake_case）。
2. **新增 `app/components/auth/`**：
   - `auth-context.tsx`：`AuthProvider` 挂载时普通 fetch `/api/auth/me`（不走 apiFetch 防循环），`useAuth()`；置于 `app/layout.tsx`。
   - `auth-gate.tsx`：loading 骨架；未登录 `router.replace('/login')`（`usePathname().startsWith('/login')` 跳过）。包裹 `/`、`/knowledge`、`/admin/users`。
   - `user-menu.tsx`：displayName + 角色徽标（管理员/知识库拥有者/成员）+ 导航（首页/知识库/用户管理[仅 admin]）+ 退出登录。放 sidebar 底部（sidebar.tsx 加可选 `footer?: ReactNode`）及 knowledge/admin 页顶部。
3. **新增 `app/login/page.tsx`**：居中卡片表单；401 显示"用户名或密码错误"；成功 `await refresh()` 后 `router.replace('/')`；已登录访问直接跳回首页。
4. **新增 `app/admin/users/page.tsx` + `admin/admin-users.tsx`**：用户表（用户名/显示名/角色下拉[管理员|知识库拥有者|普通成员]/已授权知识库数/操作）+ 创建用户弹窗 + 分配知识库弹窗（`fetchKnowledgeBases()` admin 可见全部租户 KB + checkbox + 保存）。非 admin 显示"需要管理员权限"（API 403 兜底）。
5. **`app/knowledge/knowledge-manager.tsx`**：`useAuth()`；建库表单仅 `role ∈ {owner, admin}` 可见；每张卡 `canWrite = role==='admin' || owner_user_id===user.id`，仅可写时渲染上传/删除按钮。
6. **`app/components/resilient-chat/chat-runtime.tsx`**：`createTrackedFetch()`（L229）委托 apiFetch；约 8 处裸 `fetch('/api/...')`（L484、760、863、901、950、981、1027、1076）换 apiFetch。WorkflowChatTransport 是 fetch 实现，cookie 经同源代理自动携带。

## Phase 4 — env 与文档

1. `.env.example`：`AUTH_MODE=password`、`AUTH_JWT_SECRET=<32+字符>`；注释写明 `pnpm db:migrate && pnpm db:seed` 与种子账号（admin/admin123、owner/owner123、user/user123）。
2. 修订 `docs/acceptance-auth-and-real-model.md`：L13 RBAC 行更新为"已实现（password 模式）"；L42-50 未完成项标注 Web 登录已落地（cookie 方式 + Bearer 回退）；新增 password 模式说明与浏览器验收步骤（登录/登出/用户管理/知识库授权/三角色权限矩阵）；遗留项保留"tenant 切换未实现"。
3. 修订 `README.md` 认证段落（L18、L90 附近）：password 模式与种子账号说明；生产允许 password（需 AUTH_JWT_SECRET）或 oidc，dev 仍被生产拒绝。

## 测试

**需更新**：
- `packages/db/test/knowledge-repository.test.ts:67`：断言 `ARRAY['owner','admin']` 的正则 → 新谓词（写=`ARRAY['admin']`+owner_user_id；读含 grants EXISTS）。
- `apps/api/test/knowledge-routes.test.ts:106`：canWrite mock 语义对齐 `ownerUserId===auth.userId || roles.includes('admin')`。
- `session-management.integration.test.ts`、`repository-shapes.test.ts` 的 roles fixtures（owner/member）**无需改动**（本次不改角色值与 CHECK）。

**新增**：`apps/api/test/auth-routes.test.ts`（登录设 cookie/错密码 401/me/logout）、`apps/api/test/admin-routes.test.ts`（非 admin 403、CRUD、grants 校验，参考 knowledge-routes.test.ts harness）、`packages/db/test/password.test.ts`（roundtrip/错密码/畸形 hash）。

## 边界情况

- 登录豁免必须在 preHandler 最顶部（否则登录请求先 401）。
- 401 重定向三层防循环：apiFetch 不在 /login 才跳；AuthGate 在 /login 跳过；AuthProvider 用普通 fetch。
- password 模式角色每请求从 DB 重读 → 改角色/删用户即时生效；JWT 仅作会话凭证。
- 角色语义收紧：全局角色 `owner` 不再获得他人库的写权限（旧谓词行为变化，测试同步）。
- member 被授权后仅能"使用"（RAG 检索），不能进 KB 管理页写操作（UI 隐藏 + API 写谓词拦截）。
- 已知限制（MVP）：允许降级最后一个 admin，不做锁定保护。

## 验证

1. `pnpm typecheck && pnpm test`
2. `pnpm infra:up && pnpm test:integration`（验证迁移 010）
3. `pnpm db:migrate && pnpm db:seed`（重跑 seed 验证幂等）
4. `pnpm dev` 浏览器流程：
   - 未登录访问 `/` → 跳 `/login`；`admin/admin123` 登录成功，侧栏显示管理员徽标与"用户管理"。
   - `/admin/users`：创建用户（角色 owner/member）、改角色、勾选分配知识库保存后重开仍在。
   - `owner/owner123`：可建库/传文档/删自己的库；看不到"用户管理"；他人库无上传/删除按钮。
   - `user/user123`：无建库表单、无用户管理入口；直访 `/admin/users` 显示无权限；API 403；聊天 KB 选择器出现被授权的库，RAG 引用生效；强制传未授权 kbId → 404。
   - 退出登录 → `/login`；会话中途清 cookie → 任意 API 调用跳登录且无循环。
   - `PATCH admin 改角色后`，该用户下一个请求即按新角色生效（DB 重读）。
5. 临时 `AUTH_MODE=dev` 仍按文档 L20-40 行为工作（回归保障）；`AUTH_MODE=oidc` 分支未改动。
