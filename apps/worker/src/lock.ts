import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const REFRESH_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

export async function withSessionLock<T>(
  redis: Redis,
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = `agent:session:${sessionId}:lock`;
  const token = randomUUID();
  const ttlMs = 60_000;
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') throw new Error('Session is already being processed');
  const refresh = setInterval(() => {
    void redis.eval(REFRESH_SCRIPT, 1, key, token, String(ttlMs));
  }, ttlMs / 3);
  try {
    return await action();
  } finally {
    clearInterval(refresh);
    await redis.eval(RELEASE_SCRIPT, 1, key, token);
  }
}
