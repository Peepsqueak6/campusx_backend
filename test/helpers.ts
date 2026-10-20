import mongoose from 'mongoose';
import { signToken } from '../src/auth/jwt.js';
import { User } from '../src/models/index.js';
import { getRedis } from '../src/redis.js';

let counter = 0;
const stamp = Date.now();

export async function makeUser(overrides: Record<string, unknown> = {}) {
  const n = ++counter;
  return User.create({
    email: `user${n}-${stamp}@student.test.edu`,
    handle: `@user${n}_${stamp}`,
    displayName: `User ${n}`,
    tenantDomain: 'test.edu',
    ...overrides,
  });
}

export async function makeUsers(count: number, overrides: Record<string, unknown> = {}) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await makeUser(overrides));
  return out;
}

export const bearer = (user: { _id: unknown }, iat?: number) => `Bearer ${signToken(String(user._id), 900, iat)}`;
export const id = (doc: { _id: unknown }) => String(doc._id);

/** Empties every collection (indexes stay) and the test Redis database (number 15, see test/setup.ts). */
export async function clearAll() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await getRedis().flushdb();
}
