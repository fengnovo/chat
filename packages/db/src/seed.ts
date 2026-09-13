import { createDatabase } from './index.js';
import { hashPassword } from './password.js';

// 幂等种子：默认租户 + admin/owner/user 三个演示账号。
// tenant id 与 .env 的 DEV_TENANT_ID 一致，dev 模式身份可共存于同一租户。
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const SEED_USERS = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    username: 'admin',
    password: 'admin123',
    displayName: '超级管理员',
    role: 'admin',
  },
  {
    id: '00000000-0000-4000-8000-0000000000a2',
    username: 'owner',
    password: 'owner123',
    displayName: '知识库拥有者',
    role: 'owner',
  },
  {
    id: '00000000-0000-4000-8000-0000000000a3',
    username: 'user',
    password: 'user123',
    displayName: '普通用户',
    role: 'member',
  },
] as const;

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55432/agent';
const database = createDatabase(databaseUrl);

try {
  await database.pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, '默认租户')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [TENANT_ID],
  );
  for (const seedUser of SEED_USERS) {
    const passwordHash = await hashPassword(seedUser.password);
    await database.pool.query(
      `INSERT INTO users (id, username, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET username = EXCLUDED.username,
             display_name = EXCLUDED.display_name,
             password_hash = EXCLUDED.password_hash`,
      [seedUser.id, seedUser.username, seedUser.displayName, passwordHash],
    );
    await database.pool.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [TENANT_ID, seedUser.id, seedUser.role],
    );
  }
  console.log(
    'Seed completed: tenant 默认租户, users admin/admin123, owner/owner123, user/user123.',
  );
} finally {
  await database.repository.close();
}
