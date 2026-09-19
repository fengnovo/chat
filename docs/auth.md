## 三种鉴权模式

```
AUTH_MODE=dev      → 固定身份，无需登录（本地开发用）
AUTH_MODE=password → 用户名密码 + JWT Cookie（当前用）
AUTH_MODE=oidc     → 外部 OIDC 提供商验证（生产环境用）
```

## 密码登录流程

```
┌──────────┐  POST /api/auth/login   ┌──────────┐
│  浏览器   │  {username, password}   │  Fastify │
│          │ ───────────────────────►│   API    │
│          │                         │          │
│          │    1. 查 DB 找用户       │          │
│          │    2. scrypt 验密码      │          │
│          │    3. 签发 JWT           │          │
│          │    4. Set-Cookie         │          │
│          │ ◄───────────────────────│          │
│          │   {user} + Cookie       │          │
└──────────┘                         └──────────┘
     │
     │  后续请求自动带 Cookie
     │  ┌─────────────────────────────────────┐
     └─►│ preHandler 钩子解析 Cookie → JWT 验签 │
        │ → 提取 userId/tenantId/role          │
        │ → 挂载到 request.auth                │
        └─────────────────────────────────────┘
```

**核心代码在 `auth.ts`：**

| 函数 | 作用 |
|---|---|
| `createAuthenticator()` | 根据 AUTH_MODE 创建鉴权器 |
| `signSessionToken()` | 用 `jose` 库签发 HS256 JWT |
| `jwtVerify()` | 验签 + 检查过期 |


## JWT 结构

```json
{
  "sub": "用户UUID",
  "tenant_id": "租户UUID", 
  "roles": ["admin"],
  "iat": 1234567890,
  "exp": 1234567890  // 7天后过期
}
```

用 `AUTH_JWT_SECRET`（至少32字符）做 HMAC-SHA256 签名。

## Cookie 配置

```typescript
{
  httpOnly: true,      // JS 不可访问，防 XSS
  sameSite: 'lax',     // 防 CSRF
  secure: production,  // 生产仅 HTTPS
  path: '/',
  maxAge: 7天
}
```

## OAuth 登录（叠加在密码模式上）

```
浏览器 → /api/auth/oauth/github → 302 跳转 GitHub 授权
client_id 是GitHub 分配的应用 ID，写死在配置，到时是拼在公开的url后面，所以是公开的
client_secret 是GitHub 分配的应用密钥，只在服务端用，保密，除了自己任何人都不知道
         ↓
GitHub 回调 /api/auth/oauth/github/callback?code=xxx&state=yyy
code是一次性授权码：GitHub 临时生成，5分钟过期
state是CSRF 防护令牌：你的 API 生成，HMAC 签名
         ↓
    1. 校验 state（HMAC-SHA256，防 CSRF）
    2. code 换 access_token
    3. token 获取用户信息
    4. 查/创建 oauth_accounts 关联
    5. 签发同一个 JWT Cookie
         ↓
    302 重定向到首页，已登录
```
```
1. 用户点击"GitHub登录"
   ┌────────────────────────────────────────────────────────┐
   │ API 生成 state = HMAC签名({provider, nonce, 时间戳})    │
   │ 跳转: github.com/login/oauth/authorize                 │
   │       ?client_id=Oxxxxxxxxxxxxxxxxx   ← 你的应用ID  │
   │       &scope=read:user                                 │
   │       &state=eyxxxxxxx...               ← 你生成的签名  │
   └────────────────────────────────────────────────────────┘

2. 用户在 GitHub 点"授权"
   ┌────────────────────────────────────────────────────────┐
   │ GitHub 回调你的服务器:                                   │
   │ /api/auth/oauth/github/callback                        │
   │   ?code=abc123def456    ← GitHub 临时生成的授权码        │
   │   &state=eyxxxxxxx...   ← 原样返回你之前发的 state      │
   └────────────────────────────────────────────────────────┘

3. API 服务端处理回调
   ┌────────────────────────────────────────────────────────┐
   │ ① 校验 state：HMAC 验签，防 CSRF 攻击                   │
   │ ② 用 code + client_id + client_secret 换 access_token  │
   │    POST github.com/login/oauth/access_token            │
   │    {                                                   │
   │      client_id: "Oxxxxxxxxxxxxxxxxxsss",               │
   │      client_secret: "4e05a3f8...",  ← 服务端密钥        │
   │      code: "abc123def456"           ← 用户授权码        │
   │    }                                                   │
   │ ③ 拿到 access_token，获取用户信息                        │
   └────────────────────────────────────────────────────────┘
```


**关键点：** OAuth 登录成功后签发的 Cookie 和密码登录完全一样，后续鉴权走同一条路。

## 请求鉴权中间件

```typescript
// app.ts preHandler 钩子
app.addHook('preHandler', async (request, reply) => {
  // 1. 公开路径跳过（login/register/oauth/health）
  if (PUBLIC_PATHS.has(pathname)) return;
  
  // 2. 解析 Cookie 或 Authorization 头
  request.auth = await authenticate({
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
  });
  
  // 3. 确保用户身份存在（首次登录自动创建）
  await repository.ensureIdentity(request.auth);
  
  // 4. Redis 限流
  // ...
});
```

## 数据表关系

```
users                    tenant_memberships           oauth_accounts
┌─────────┐             ┌──────────────────┐         ┌────────────────┐
│ id (PK) │◄────────────│ user_id          │         │ id (PK)        │
│ username│             │ tenant_id        │         │ user_id (FK)   │
│ password│             │ role             │         │ provider       │
│ display │             └──────────────────┘         │ subject        │
└─────────┘                                          │ email/avatar   │
                                                     └────────────────┘
```

## 一句话总结

**密码登录**：用户名密码 → scrypt 验 hash → 签 JWT → 存 Cookie → 后续请求验签解析身份

**OAuth 登录**：第三方授权 → code 换 token → 获取用户信息 → 关联本地账号 → 签同一个 JWT Cookie

两者最终都产出相同的 JWT Cookie，后续鉴权走同一条路。


**OAuth 登录原理总结：**

```
┌─────────┐     1. 点击"GitHub登录"      ┌─────────┐
│  浏览器  │ ──────────────────────────► │  API    │
│         │     GET /api/auth/oauth/github│ 8002   │
│         │ ◄────────────────────────── │        │
│         │   302 跳转到 GitHub 授权页    │        │
└─────────┘                             └─────────┘
     │                                        │
     │  2. 用户在 GitHub 授权                  │
     │ ─────────────────────────────────────► │
     │                                        │
     │  3. GitHub 回调带 code                  │
     │ ─────────────────────────────────────► │
     │  GET /api/auth/oauth/github/callback   │
     │      ?code=xxx&state=yyy               │
     │                                        │
     │                   4. API 用 code 换 access_token
     │                      5. 用 token 获取用户信息
     │                      6. 查找/创建本地用户
     │                      7. 签发 JWT Cookie
     │                                        │
     │  8. 302 重定向到首页，带 Cookie          │
     │ ◄───────────────────────────────────── │
     │                                        │
     │  9. 后续请求自动带 Cookie 鉴权           │
```

**关键点：**

| 环节 | 说明 |
|---|---|
| State 防 CSRF | 用 HMAC-SHA256 签名，10 分钟有效 |
| Token 交换 | 服务端用 code + client_secret 换 access_token |
| 用户关联 | `oauth_accounts` 表存 provider + subject（外部用户唯一ID） |
| 会话管理 | 复用现有 JWT Cookie 机制，与密码登录完全一致 |
| 正交设计 | OAuth 与 AUTH_MODE 无关，password 模式下可叠加使用 |

## 未登录访问页面

```
┌─────────┐                          ┌──────────┐
│  浏览器  │                          │  API     │
│         │  1. 打开任意页面           │          │
│         │  ┌─────────────────────┐  │          │
│         │  │ AuthProvider 挂载    │  │          │
│         │  │ 立即调用 /api/auth/me│  │          │
│         │ └─────────────────────┘  │          │
│         │ ───────────────────────► │          │
│         │  GET /api/auth/me        │          │
│         │  (没有 Cookie)           │          │
│         │                          │          │
│         │ ◄─────────────────────── │          │
│         │  401 Unauthorized        │          │
│         │                          │          │
│         │  2. 收到 401             │          │
│         │  setUser(null)           │          │
│         │  setLoading(false)       │          │
│         │                          │          │
│         │  ┌─────────────────────┐  │          │
│         │  │ AuthGate 检测到:    │  │          │
│         │  │ loading=false       │  │          │
│         │  │ user=null           │  │          │
│         │  │ → router.replace('/login')│       │
│         │  └─────────────────────┘  │          │
│         │                          │          │
│         │  3. 跳转到登录页          │          │
└─────────┘                          └──────────┘
```

**关键代码：**

```typescript
// auth-context.tsx - 页面加载时立即探测
useEffect(() => {
  fetchCurrentUser()  // GET /api/auth/me
    .then((next) => { if (active) setUser(next); })
    .catch(() => { setUser(null); });  // 401 时 user = null
}, []);

// auth-gate.tsx - 未登录则跳转
useEffect(() => {
  if (!loading && !user) {
    router.replace('/login');  // 跳登录页
  }
}, [loading, user, router]);
```

## 已登录访问页面

```
┌─────────┐                          ┌──────────┐
│  浏览器  │                          │  API     │
│         │  1. 打开任意页面           │          │
│         │  (浏览器自动带 Cookie)      │          │
│         │ ───────────────────────► │          │
│         │  GET /api/auth/me        │          │
│         │  Cookie: agent_session=xx│          │
│         │                          │          │
│         │           preHandler 钩子:│          │
│         │           1. 解析 Cookie  │          │
│         │           2. JWT 验签     │          │
│         │           3. 查 DB 角色   │          │
│         │           4. 挂载 auth    │          │
│         │                          │          │
│         │ ◄─────────────────────── │          │
│         │  200 {user: {...}}       │          │
│         │                          │          │
│         │  2. setUser(user)        │          │
│         │  AuthGate 放行           │          │
│         │  渲染页面内容             │          │
└─────────┘                          └──────────┘
```

## 为什么控制台看到 401？

| 场景 | 是否正常 |
|---|---|
| 未登录时看到 `/api/auth/me` 401 | ✅ 正常，前端探测登录状态 |
| 已登录后看到 401 | ❌ 不正常，Cookie 丢失或过期 |

**这是 SPA 的标准鉴权模式**：前端不知道用户是否登录，必须先问后端。401 是后端回答"没登录"，前端据此跳转登录页。

## 登录页特殊处理

登录页 (`/login`) 不包裹 `AuthGate`，所以不会死循环跳转：

```
未登录 → / → AuthGate 检测 user=null → 跳 /login
登录页自身不包裹 AuthGate → 显示登录表单
登录成功 → setUser(user) → router.replace('/') → 进入首页
```
---
## 几个问题

### 问题1: 如果知道客户端这边的client_id并伪造state，也是可以获得github的授权code的？  
对了一半。让我拆解一下攻击场景：

###### 攻击者能做什么

```
攻击者知道:
  ✅ client_id        → 公开信息，本来就写在 URL 里
  ✅ 伪造 state       → 可以自己签一个

攻击者可以构造:
  github.com/login/oauth/authorize?client_id=xxx&state=伪造的&scope=...
```

**攻击者确实可以诱骗用户点击这个链接，用户授权后 GitHub 会返回 `code`。**

###### 但攻击者拿不到有用的东西

```
GitHub 回调去哪？
  → 你注册的 callback URL（你的服务器）
  → 不是攻击者的服务器

code 到了你的服务器后:
  → 你的服务器用 client_secret 换 access_token
  → 攻击者没有 client_secret，换不了 token

攻击者能截获 code 吗？
  → 不能，code 通过 302 redirect 发到你的服务器
  → 攻击者看不到这个请求
```

###### 真正的风险：CSRF（state 防的就是这个）

```
没有 state 保护时:

1. 攻击者自己点 GitHub 授权，拿到一个 code
2. 诱导受害者点击: your-site.com/callback?code=攻击者的code
3. 你的服务器用这个 code 换 token
4. 受害者的浏览器被登录成攻击者的账号

这就是 CSRF 攻击（账号劫持）
```

**`state` 的作用**：

```
有 state 保护时:

1. 你的服务器生成 state = HMAC({nonce, 时间戳})
2. 跳转 GitHub: ...&state=xxx
3. GitHub 回调: ?code=yyy&state=xxx
4. 你的服务器验签 state → 确认"这个回调是我发起的"
5. 攻击者伪造的 state 过不了验签（没有 HMAC 密钥）
```

###### 安全边界总结

| 信息 | 公开/私有 | 泄露后果 |
|---|---|---|
| `client_id` | 公开 | 无风险，本来就是公开的 |
| `client_secret` | **私有** | 灾难！攻击者可以换 token，冒充任何用户 |
| `state` 签名密钥 | **私有** | 风险！CSRF 防护失效 |
| `code` | 一次性，5分钟 | 无风险，没有 client_secret 换不了 token |

###### 一句话

**`client_id` 公开无所谓，`state` 伪造只能构造钓鱼链接，但 code 会回到你的服务器，攻击者拿不到。真正的红线是 `client_secret`，绝对不能泄露。**

### 问题2: 攻击者不能也用`state = HMAC({nonce, 时间戳})`伪造 state？  
不能。关键在于 **HMAC 需要一个密钥**。
###### HMAC 签名原理

```
HMAC(密钥, 消息) → 签名

你的服务器:
  密钥 = AUTH_JWT_SECRET = "aa3aaa791f15b380..."  ← 只有你知道
  消息 = {"provider":"github","nonce":"uuid","iat":1234567890}
  结果 = "eyJwcm92a...abc123"

攻击者:
  密钥 = ???  ← 不知道！
  消息 = {"provider":"github","nonce":"uuid","iat":1234567890}
  结果 = "xyz789..."  ← 完全不同的签名
```

###### 代码里的密钥从哪来

```typescript
// config.ts
OAUTH: {
  stateSecret: value.OAUTH_STATE_SECRET ?? value.AUTH_JWT_SECRET,
}

// oauth-routes.ts - 签名
const state = await signState(provider, nonce, stateSecret);

// oauth-routes.ts - 验签
const valid = await verifyState(query.state, provider, stateSecret);
```

**攻击者不知道 `AUTH_JWT_SECRET`，所以伪造不了合法的 state 签名。**
###### 验证过程
```
你的服务器发起:
  state = HMAC("aa3aaa...", {github, uuid1, 1234567890})
        = "eyxxxxxx...abc123"

攻击者想伪造:
  state = HMAC("???", {github, uuid2, 1234567890})
        = "xyz789..."  ← 乱签的

GitHub 回调你的服务器:
  ?code=xxx&state=xyz789...

你的服务器验签:
  verifyState("xyz789...", "github", "aa3aaa...")
  → 签名不匹配 → 拒绝！
  → redirect /login?error=oauth_state_invalid
```
###### 一句话
**HMAC = Hash + 密钥。没有密钥，算不出合法签名。这就是密码学的安全边界。**

### 问题3: 它也拿自己在网站上弄的state啊，跟client ID类似拼在公开的url后面，这state也是我们服务器生成的啊？

攻击者确实可以从你的网站获取一个合法的 state。但关键是：**拿到 state 之后呢？**

###### 攻击者能做到的
```
1. 攻击者访问你的网站
2. 点击"GitHub 登录"
3. 你的服务器生成了合法 state ✅
4. 跳转到 GitHub，攻击者授权
5. GitHub 回调你的服务器，带 code + state
6. 你的服务器验签 state → 通过 ✅
7. 用 code + client_secret 换 token → 获取攻击者的 GitHub 用户信息
8. 创建/关联攻击者的账号 → 签发 Cookie
9. 攻击者登录了... 攻击者自己的账号
```

**这不是攻击，这就是正常的 OAuth 登录流程。攻击者登录的是他自己的账号。**

###### 攻击者真正想做的（state 防的就是这个）
```
目标：让受害者登录成攻击者的账号（CSRF 账号劫持）

没有 state 时：
  1. 攻击者获取一个 code（自己的授权码）
  2. 诱导受害者点击：
     your-site.com/api/auth/oauth/github/callback?code=攻击者的code
  3. 你的服务器用这个 code 换 token → 拿到攻击者的 GitHub 身份
  4. 给受害者的浏览器签发 Cookie
  5. 受害者被登录成攻击者的账号 → 后续操作都绑定到攻击者名下

有 state 时：
  1. 攻击者获取一个 code + 对应的 state
  2. 诱导受害者点击：
     your-site.com/api/auth/oauth/github/callback
       ?code=攻击者的code&state=攻击者的state
  3. 你的服务器验签 state → 检查"这个 state 是发给哪个浏览器的？"
  
  关键：state 里包含 nonce，你的服务器记录了"这个 nonce 是给哪个会话发起的"
  
  受害者的浏览器带着这个 state 来回调
  → 服务器发现：这个 state 对应的发起者不是受害者
  → 拒绝！→ oauth_state_invalid
```
###### 实际上你的代码里 state 还有一层保护
```typescript
// signState - state 里绑定了 provider 和时间戳
const payload = JSON.stringify({ provider, nonce, iat: Date.now() });

// verifyState - 验签时检查
if (parsed.provider !== expectedProvider) return false;  // provider 必须匹配
if (Date.now() - parsed.iat > 10 * 60 * 1000) return false;  // 10 分钟过期
```

state 是 **HMAC 签名的整体**，不是单独一个字段。攻击者看到 `state=eyxxxxxxx...abc123`，他不知道里面是什么，也不能修改任何部分，因为改了之后签名就对不上了。

###### 一句话
**攻击者可以获取合法 state，但只能登录自己的账号。state 防的是"把攻击者的 code 塞给受害者浏览器"这种 CSRF 攻击，而不是防攻击者自己登录。**


### 问题4: 也就是我的服务器不关心，什么用户登录，只认这个链接是我授权生成出去的，然后我获取github合法的授权code，就给这个用户生成token，用作登录态。

对，理解完全正确。

###### 你的服务器做的事
```
1. state 验签 → "这个回调是我发起的" ✅
2. code + client_secret → 换 access_token ✅
3. access_token → 获取 GitHub 用户信息 ✅
4. "哦，你是 GitHub 用户 xxx" → 查/创建本地账号 → 签发 JWT Cookie
```

**服务器不验证"你是谁"，服务器信任 GitHub 告诉它的身份。**

###### 安全链条

| 环节 | 谁负责 | 保证什么 |
|---|---|---|
| GitHub 登录页 | GitHub | 确认用户确实是这个 GitHub 账号的主人 |
| `code` | GitHub 生成 | 一次性凭证，证明"GitHub 同意授权" |
| `client_secret` | 你的服务器 | 证明"请求来自你的应用，不是第三方" |
| `state` | 你的服务器 | 证明"回调是我发起的，不是 CSRF" |
| `access_token` | GitHub 签发 | 用来获取用户信息 |
| JWT Cookie | 你的服务器签发 | 后续请求的登录态 |

###### 一句话

**OAuth 的本质是：GitHub 帮你验证用户身份，你的服务器只负责确认流程合法（state）+ 用密钥换凭证（client_secret + code）→ 然后给这个用户发你自己的登录令牌（JWT）。**

### 问题5: 也就是即使一个固定的state，只要这个state是我服务器生成的，后面的回调拼的是哪个账号的github 的授权code，那么它就是生成哪个github对应的token

对，完全正确。
```
state 固定 → 只证明"这个回调是我服务器发起的"

code 才是关键 → 决定是哪个 GitHub 用户授权的

  用户 A 授权 → code=A → 换 token → 获取用户 A 的信息 → 签发 A 的 JWT
  用户 B 授权 → code=B → 换 token → 获取用户 B 的信息 → 签发 B 的 JWT
```

**state 管"流程合法性"，code 管"谁在登录"。两者职责完全不同。**

### 问题6: 事实上我们服务器上的state是固定的吗

不是固定的。每次发起 OAuth 登录都会生成一个**全新的 state**。
```typescript
// oauth-routes.ts
const nonce = randomUUID();                          // ← 每次随机
const state = await signState(provider, nonce, stateSecret);

// signState 内部
const payload = JSON.stringify({ provider, nonce, iat: Date.now() });
//                                               ↑ 当前时间戳
```

###### 每次登录的 state 都不同

```
用户 A 点击登录 → state = HMAC(secret, {github, uuid-1, 1234567890})
用户 B 点击登录 → state = HMAC(secret, {github, uuid-2, 1234567900})
同一用户再次点  → state = HMAC(secret, {github, uuid-3, 1234568000})
```

三个不同点：
| 字段 | 变化 |
|---|---|
| `nonce` | 每次 `randomUUID()`，全局唯一 |
| `iat` | 每次取当前时间戳 |
| 签名结果 | nonce/时间不同 → 签名完全不同 |

###### 还有过期机制

```typescript
// verifyState 里
if (Date.now() - parsed.iat > 10 * 60 * 1000) return false;
//                           ↑ 10 分钟过期
```

所以即使攻击者截获了一个 state，10 分钟后就废了。

**总结：state 每次随机生成、不可预测、10 分钟过期。攻击者无法复用。**