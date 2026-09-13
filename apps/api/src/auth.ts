import type { AuthContext } from '@repo/contracts';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { z } from 'zod';

import type { ApiConfig } from './config.js';

export const SESSION_COOKIE_NAME = 'agent_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function rolesOf(payload: JWTPayload): string[] {
  const roles = payload.roles;
  const allowed = new Set(['owner', 'admin', 'member']);
  return Array.isArray(roles)
    ? roles.filter(
        (role): role is string => typeof role === 'string' && allowed.has(role),
      )
    : [];
}

export interface AuthenticatorOptions {
  /** password 模式下从数据库解析成员角色，保证改角色/删用户即时生效。 */
  loadMembership?: (
    tenantId: string,
    userId: string,
  ) => Promise<string | null>;
}

export function createAuthenticator(
  config: ApiConfig,
  options: AuthenticatorOptions = {},
) {
  if (config.AUTH_MODE === 'dev') {
    return async (): Promise<AuthContext> => ({
      tenantId: config.DEV_TENANT_ID,
      userId: config.DEV_USER_ID,
      roles: ['owner'],
    });
  }

  if (config.AUTH_MODE === 'password') {
    const secretText = config.AUTH_JWT_SECRET;
    if (!secretText) {
      throw new Error('AUTH_JWT_SECRET is required when AUTH_MODE=password');
    }
    const secret = new TextEncoder().encode(secretText);
    const loadMembership =
      options.loadMembership ??
      (async () => null);
    return async (credentials?: {
    authorization?: string | undefined;
    cookie?: string | undefined;
  }): Promise<AuthContext> => {
    const bearer = credentials?.authorization;
      let token: string | undefined;
      if (bearer?.startsWith('Bearer ')) {
        token = bearer.slice('Bearer '.length);
      } else if (credentials?.cookie) {
        for (const pair of credentials.cookie.split(';')) {
          const [name, ...rest] = pair.trim().split('=');
          if (name === SESSION_COOKIE_NAME) {
            token = rest.join('=');
            break;
          }
        }
      }
      if (!token) throw new AuthenticationError();
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, secret));
      } catch {
        throw new AuthenticationError();
      }
      const subject = payload.sub;
      const tenantId = payload.tenant_id;
      if (
        typeof subject !== 'string' ||
        typeof tenantId !== 'string' ||
        !z.uuid().safeParse(subject).success ||
        !z.uuid().safeParse(tenantId).success
      ) {
        throw new AuthenticationError(
          'Token sub and tenant_id must be internal UUID identifiers',
        );
      }
      const role = await loadMembership(tenantId, subject);
      if (!role) throw new AuthenticationError('Membership not found');
      return { userId: subject, tenantId, roles: [role] };
    };
  }

  const issuer = config.OIDC_ISSUER;
  const audience = config.OIDC_AUDIENCE;
  const jwksUrl = config.OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) {
    throw new Error('OIDC configuration is incomplete');
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async (credentials?: {
    authorization?: string | undefined;
    cookie?: string | undefined;
  }): Promise<AuthContext> => {
    const authorization = credentials?.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new AuthenticationError();
    const token = authorization.slice('Bearer '.length);
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
    });
    const subject = payload.sub;
    const tenantId = payload.tenant_id;
    if (
      typeof subject !== 'string' ||
      typeof tenantId !== 'string' ||
      !z.uuid().safeParse(subject).success ||
      !z.uuid().safeParse(tenantId).success
    ) {
      throw new AuthenticationError(
        'Token sub and tenant_id must be internal UUID identifiers',
      );
    }
    const roles = rolesOf(payload);
    return {
      userId: subject,
      tenantId,
      roles: roles.length > 0 ? roles : ['member'],
    };
  };
}

export async function signSessionToken(
  config: ApiConfig,
  input: { userId: string; tenantId: string; role: string },
): Promise<string> {
  const secretText = config.AUTH_JWT_SECRET;
  if (!secretText) {
    throw new Error('AUTH_JWT_SECRET is required when AUTH_MODE=password');
  }
  const secret = new TextEncoder().encode(secretText);
  return new SignJWT({ tenant_id: input.tenantId, roles: [input.role] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

export function requireAdmin(auth: AuthContext): void {
  if (!auth.roles.includes('admin')) {
    throw new ForbiddenError('Admin role required');
  }
}

export class AuthenticationError extends Error {
  statusCode = 401;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ForbiddenError extends Error {
  statusCode = 403;

  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
