import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AgentRepository } from '@repo/db';
import { hashPassword, verifyPassword } from '@repo/db';

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

function setSessionCookie(reply: FastifyReply, config: ApiConfig, token: string) {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS,
    // 开发环境显式指定 domain=localhost，使 API (8002) 与前端 (3020) 共享 Cookie。
    ...(config.NODE_ENV !== 'production' ? { domain: 'localhost' } : {}),
  });
}

// 与 admin 创建用户保持同一套用户名/密码规则。
const credentialsSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9_.-]{3,64}$/),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});

export async function registerAuthRoutes(app: FastifyInstance, services: Services) {
  app.post('/api/auth/login', async (request, reply) => {
    const input = z
      .object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(200),
      })
      .parse(request.body ?? {});

    const user = await services.repository.findUserForLogin(input.username);
    const passwordOk = await verifyPassword(input.password, user?.passwordHash);
    if (!user || !passwordOk) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = await signSessionToken(services.config, {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
    });
    setSessionCookie(reply, services.config, token);
    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        tenantId: user.tenantId,
      },
    };
  });

  // 公开自助注册：仅 password 模式且 SIGNUP_ENABLED 时开放；新用户一律为 member，
  // 加入 SIGNUP_TENANT_ID（默认 seed 租户），由 admin 后续提权或授权知识库。
  app.post('/api/auth/register', async (request, reply) => {
    const { config, repository } = services;
    if (config.AUTH_MODE !== 'password' || !config.SIGNUP_ENABLED) {
      return reply.code(403).send({ error: 'signup_disabled' });
    }
    const input = credentialsSchema.parse(request.body ?? {});
    const tenantId = config.SIGNUP_TENANT_ID;
    const created = await repository.createTenantUser(tenantId, {
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: 'member',
    });
    // 注册即登录，省去注册后再手动登录的一步。
    const token = await signSessionToken(config, {
      userId: created.id,
      tenantId,
      role: 'member',
    });
    setSessionCookie(reply, config, token);
    return reply.code(201).send({
      user: {
        id: created.id,
        displayName: created.displayName,
        role: 'member' as const,
        tenantId,
      },
    });
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  // 自助修改密码：仅 password 模式开放，必须校验当前密码，新密码沿用注册/管理员建号规则。
  // 修改成功后当前会话 Cookie（JWT）继续有效，无需重新登录。
  app.post('/api/auth/change-password', async (request, reply) => {
    if (services.config.AUTH_MODE !== 'password') {
      return reply.code(403).send({ error: 'password_change_unavailable' });
    }
    const input = z
      .object({
        currentPassword: z.string().min(1).max(200),
        newPassword: z.string().min(8).max(200),
      })
      .refine((value) => value.newPassword !== value.currentPassword, {
        message: 'new_password_must_differ',
        path: ['newPassword'],
      })
      .parse(request.body ?? {});

    const passwordHash = await services.repository.getUserPasswordHash(
      request.auth.tenantId,
      request.auth.userId,
    );
    if (!passwordHash) {
      // 当前账号没有密码凭据（正常 password 模式不会出现），失败收口而非放行。
      return reply.code(403).send({ error: 'password_change_unavailable' });
    }
    const passwordOk = await verifyPassword(input.currentPassword, passwordHash);
    if (!passwordOk) {
      return reply.code(401).send({ error: 'invalid_current_password' });
    }

    const updated = await services.repository.updateTenantUser(
      request.auth.tenantId,
      request.auth.userId,
      { passwordHash: await hashPassword(input.newPassword) },
    );
    if (!updated) {
      return reply.code(404).send({ error: 'user_not_found' });
    }
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const auth = request.auth;
    const displayName = await services.repository.getUserDisplayName(
      auth.tenantId,
      auth.userId,
    );
    const avatarUrl = await services.repository.getUserAvatarUrl(
      auth.tenantId,
      auth.userId,
    );
    const passwordHash = await services.repository.getUserPasswordHash(
      auth.tenantId,
      auth.userId,
    );
    return {
      user: {
        id: auth.userId,
        displayName: displayName ?? 'Agent user',
        role: auth.roles[0] ?? 'member',
        tenantId: auth.tenantId,
        // dev 模式没有真实登录态，前端据此隐藏"退出登录"等会话操作。
        authMode: services.config.AUTH_MODE,
        // OAuth 登录用户没有密码，前端据此隐藏"修改密码"入口。
        hasPassword: passwordHash !== null,
        avatarUrl,
      },
    };
  });
}
