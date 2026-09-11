import type { AuthContext } from '@repo/contracts';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import type { ApiConfig } from './config.js';

function rolesOf(payload: JWTPayload): string[] {
  const roles = payload.roles;
  const allowed = new Set(['owner', 'admin', 'member']);
  return Array.isArray(roles)
    ? roles.filter(
        (role): role is string => typeof role === 'string' && allowed.has(role),
      )
    : [];
}

export function createAuthenticator(config: ApiConfig) {
  if (config.AUTH_MODE === 'dev') {
    return async (): Promise<AuthContext> => ({
      tenantId: config.DEV_TENANT_ID,
      userId: config.DEV_USER_ID,
      roles: ['owner'],
    });
  }

  const issuer = config.OIDC_ISSUER;
  const audience = config.OIDC_AUDIENCE;
  const jwksUrl = config.OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) {
    throw new Error('OIDC configuration is incomplete');
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async (authorization?: string): Promise<AuthContext> => {
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

export class AuthenticationError extends Error {
  statusCode = 401;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthenticationError';
  }
}
