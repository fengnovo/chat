import test from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword } from '../src/password.js';

test('hashPassword produces a scrypt hash that verifies the original password', async () => {
  const stored = await hashPassword('admin123');
  const [scheme, salt, digest] = stored.split('$') as [string, string, string];
  assert.equal(scheme, 'scrypt');
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.match(digest, /^[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('admin123', stored), true);
});

test('same password hashes differently (unique salt) but both verify', async () => {
  const first = await hashPassword('owner123');
  const second = await hashPassword('owner123');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('owner123', first), true);
  assert.equal(await verifyPassword('owner123', second), true);
});

test('wrong password fails without throwing', async () => {
  const stored = await hashPassword('user123');
  assert.equal(await verifyPassword('user321', stored), false);
});

test('malformed or missing stored hashes never verify', async () => {
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', undefined), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'plaintext'), false);
  assert.equal(await verifyPassword('x', 'bcrypt$aa$bb'), false);
  assert.equal(await verifyPassword('x', 'scrypt$zz$cc'), false);
  assert.equal(await verifyPassword('x', 'scrypt$aabb$ccdd'), false);
});
