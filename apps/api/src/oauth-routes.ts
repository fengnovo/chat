import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ProxyAgent, type Dispatcher } from 'undici';

import type { AgentRepository } from '@repo/db';

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  signSessionToken,
} from './auth.js';
import type { ApiConfig } from './config.js';

type Services = {
  config: ApiConfig;
  repository: AgentRepository;
};

type OAuthProvider = 'github' | 'google';

type OAuthProfile = {
  subject: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
};

// ---- State 签名 / 校验（HMAC-SHA256 + base64url） ----

async function signState(provider: string, nonce: string, secret: string): Promise<string> {
  const payload = JSON.stringify({ provider, nonce, iat: Date.now() });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  const sigHex = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${base64urlEncode(payload)}.${sigHex}`;
}

async function verifyState(
  state: string,
  expectedProvider: string,
  secret: string,
): Promise<boolean> {
  const dotIndex = state.lastIndexOf('.');
  if (dotIndex < 0) return false;
  const payloadB64 = state.slice(0, dotIndex);
  const sigHex = state.slice(dotIndex + 1);
  const payload = base64urlDecode(payloadB64);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = hexToBytes(sigHex);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(payload),
  );
  if (!valid) return false;
  const parsed = JSON.parse(payload) as { provider: string; iat: number };
  if (parsed.provider !== expectedProvider) return false;
  // State 有效期 10 分钟。
  if (Date.now() - parsed.iat > 10 * 60 * 1000) return false;
  return true;
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64url')
    .replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---- Provider 配置 ----

function getProviderConfig(config: ApiConfig, provider: OAuthProvider) {
  if (provider === 'github') return config.OAUTH.github;
  if (provider === 'google') return config.OAUTH.google;
  return undefined;
}

function buildAuthorizationUrl(
  config: ApiConfig,
  provider: OAuthProvider,
  state: string,
): string {
  const callbackUrl = config.OAUTH.callbackUrl ?? `${config.WEB_ORIGIN}/api/auth/oauth/${provider}/callback`;
  if (provider === 'github') {
    const params = new URLSearchParams({
      client_id: config.OAUTH.github!.clientId,
      scope: 'read:user user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }
  // Google
  const params = new URLSearchParams({
    client_id: config.OAUTH.google!.clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ---- Token 交换 & 用户信息 ----

async function exchangeGitHubCode(code: string, config: ApiConfig): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.OAUTH.github!.clientId,
      client_secret: config.OAUTH.github!.clientSecret,
      code,
    }),
  });
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('github_token_exchange_failed');
  return data.access_token;
}

async function fetchGitHubProfile(accessToken: string): Promise<OAuthProfile> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Keen-AI-Platform',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) throw new Error('github_profile_fetch_failed');
  const user = (await response.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string;
    email: string | null;
  };
  return {
    subject: String(user.id),
    email: user.email,
    displayName: user.name ?? user.login,
    avatarUrl: user.avatar_url,
  };
}

// 国内访问 Google API 需要代理；从 HTTPS_PROXY 环境变量读取。
function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

async function exchangeGoogleCode(code: string, config: ApiConfig): Promise<string> {
  const callbackUrl = config.OAUTH.callbackUrl ?? `${config.WEB_ORIGIN}/api/auth/oauth/google/callback`;
  const init: Record<string, unknown> = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.OAUTH.google!.clientId,
      client_secret: config.OAUTH.google!.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl,
    }),
  };
  const dispatcher = getProxyDispatcher();
  if (dispatcher) init.dispatcher = dispatcher;
  const response = await fetch('https://oauth2.googleapis.com/token', init as any);
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('google_token_exchange_failed');
  return data.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<OAuthProfile> {
  const init: Record<string, unknown> = {
    headers: { Authorization: `Bearer ${accessToken}` },
  };
  const dispatcher = getProxyDispatcher();
  if (dispatcher) init.dispatcher = dispatcher;
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', init as any);
  if (!response.ok) throw new Error('google_profile_fetch_failed');
  const user = (await response.json()) as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };
  return {
    subject: user.id,
    email: user.email,
    displayName: user.name,
    avatarUrl: user.picture,
  };
}

// ---- 路由注册 ----

export async function registerOAuthRoutes(app: FastifyInstance, services: Services) {
  const { config, repository } = services;

  // GET /api/auth/oauth/providers — 返回已配置的 OAuth 提供商列表
  app.get('/api/auth/oauth/providers', async () => {
    const providers: string[] = [];
    if (config.OAUTH.github) providers.push('github');
    if (config.OAUTH.google) providers.push('google');
    return { data: providers };
  });

  // GET /api/auth/oauth/:provider — 发起 OAuth 授权跳转
  app.get('/api/auth/oauth/:provider', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (provider !== 'github' && provider !== 'google') {
      return reply.code(400).send({ error: 'unsupported_provider' });
    }
    const providerConfig = getProviderConfig(config, provider);
    if (!providerConfig) {
      return reply.code(400).send({ error: 'provider_not_configured' });
    }
    const stateSecret = config.OAUTH.stateSecret;
    if (!stateSecret) {
      return reply.code(500).send({ error: 'oauth_state_secret_not_configured' });
    }
    const nonce = randomUUID();
    const state = await signState(provider, nonce, stateSecret);
    const authorizationUrl = buildAuthorizationUrl(config, provider, state);
    return reply.redirect(authorizationUrl);
  });

  // GET /api/auth/oauth/:provider/callback — OAuth 回调
  app.get('/api/auth/oauth/:provider/callback', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (provider !== 'github' && provider !== 'google') {
      return reply.code(400).send({ error: 'unsupported_provider' });
    }
    const providerConfig = getProviderConfig(config, provider);
    if (!providerConfig) {
      return reply.code(400).send({ error: 'provider_not_configured' });
    }
    const stateSecret = config.OAUTH.stateSecret;
    if (!stateSecret) {
      return reply.code(500).send({ error: 'oauth_state_secret_not_configured' });
    }

    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      return reply.redirect(`${config.WEB_ORIGIN}/login?error=oauth_denied`);
    }
    if (!query.code || !query.state) {
      return reply.redirect(`${config.WEB_ORIGIN}/login?error=oauth_missing_params`);
    }

    // 校验 state
    const stateValid = await verifyState(query.state, provider, stateSecret);
    if (!stateValid) {
      return reply.redirect(`${config.WEB_ORIGIN}/login?error=oauth_state_invalid`);
    }

    try {
      // 交换 access token
      const accessToken =
        provider === 'github'
          ? await exchangeGitHubCode(query.code, config)
          : await exchangeGoogleCode(query.code, config);

      // 获取用户信息
      const profile =
        provider === 'github'
          ? await fetchGitHubProfile(accessToken)
          : await fetchGoogleProfile(accessToken);

      // 查找或创建用户
      let oauthUser = await repository.findOAuthAccount(provider, profile.subject);
      if (!oauthUser) {
        const tenantId = config.SIGNUP_TENANT_ID;
        const created = await repository.createOAuthUser(tenantId, {
          provider,
          subject: profile.subject,
          email: profile.email,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          role: 'member',
        });
        oauthUser = {
          userId: created.id,
          displayName: created.displayName,
          tenantId,
          role: created.role,
        };
      }

      // 签发会话 Cookie
      const token = await signSessionToken(config, {
        userId: oauthUser.userId,
        tenantId: oauthUser.tenantId,
        role: oauthUser.role,
      });
      reply.setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: config.NODE_ENV === 'production',
        maxAge: SESSION_TTL_SECONDS,
        // 开发环境显式指定 domain=localhost，使 API (8002) 与前端 (3020) 共享 Cookie。
        ...(config.NODE_ENV !== 'production' ? { domain: 'localhost' } : {}),
      });
      return reply.redirect(`${config.WEB_ORIGIN}/`);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      app.log.error({ error: err, stack: error instanceof Error ? error.stack : undefined }, 'OAuth callback failed');
      return reply.redirect(`${config.WEB_ORIGIN}/login?error=oauth_failed&detail=${encodeURIComponent(err)}`);
    }
  });
}
