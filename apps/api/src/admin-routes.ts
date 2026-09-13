import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { RepositoryNotFoundError, hashPassword } from '@repo/db';

import { requireAdmin } from './auth.js';
import type { AgentRepository } from '@repo/db';

type Services = {
  repository: AgentRepository;
};

const roleSchema = z.enum(['admin', 'owner', 'member']);
const id = z.uuid();

function notFound(reply: any, error = 'not_found') {
  return reply.code(404).send({ error });
}

export async function registerAdminRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/admin/users', async (request) => {
    requireAdmin(request.auth);
    return {
      data: await services.repository.listTenantUsers(request.auth.tenantId),
    };
  });

  app.post('/api/admin/users', async (request, reply) => {
    requireAdmin(request.auth);
    const input = z
      .object({
        username: z.string().trim().regex(/^[a-zA-Z0-9_.-]{3,64}$/),
        displayName: z.string().trim().min(1).max(120),
        password: z.string().min(8).max(200),
        role: roleSchema,
      })
      .parse(request.body ?? {});
    const user = await services.repository.createTenantUser(request.auth.tenantId, {
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    });
    return reply.code(201).send(user);
  });

  app.patch('/api/admin/users/:userId', async (request, reply) => {
    requireAdmin(request.auth);
    const { userId } = request.params as { userId: string };
    const input = z
      .object({
        role: roleSchema.optional(),
        displayName: z.string().trim().min(1).max(120).optional(),
        password: z.string().min(8).max(200).optional(),
      })
      .refine((value) => Object.keys(value).length > 0, { message: 'empty_patch' })
      .parse(request.body ?? {});
    const user = await services.repository.updateTenantUser(
      request.auth.tenantId,
      id.parse(userId),
      {
        ...(input.role ? { role: input.role } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.password
          ? { passwordHash: await hashPassword(input.password) }
          : {}),
      },
    );
    if (!user) return notFound(reply, 'user_not_found');
    return user;
  });

  app.get('/api/admin/users/:userId/knowledge-bases', async (request, reply) => {
    requireAdmin(request.auth);
    const { userId } = request.params as { userId: string };
    return {
      data: await services.repository.listKnowledgeBaseGrants(
        request.auth.tenantId,
        id.parse(userId),
      ),
    };
  });

  app.put('/api/admin/users/:userId/knowledge-bases', async (request, reply) => {
    requireAdmin(request.auth);
    const { userId } = request.params as { userId: string };
    const input = z
      .object({ knowledgeBaseIds: z.array(z.uuid()) })
      .parse(request.body ?? {});
    try {
      const granted = await services.repository.replaceKnowledgeBaseGrants(
        request.auth.tenantId,
        id.parse(userId),
        input.knowledgeBaseIds,
        request.auth.userId,
      );
      return { data: granted };
    } catch (error) {
      if (error instanceof RepositoryNotFoundError) {
        return notFound(reply, `${error.resource}_not_found`);
      }
      throw error;
    }
  });
}
