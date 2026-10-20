import { Redis, type RedisOptions } from 'ioredis';
import { config } from './config.js';
import { ENFORCEMENT_CHANNEL } from './constants.js';

let shared: Redis | undefined;

/** Shared connection for commands. Pub/sub and BullMQ need their own connections (see newRedis). */
export const getRedis = (): Redis => (shared ??= new Redis(config.redisUrl, { maxRetriesPerRequest: 2 }));

export const newRedis = (opts: RedisOptions = {}): Redis => new Redis(config.redisUrl, opts);

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = undefined;
  }
}

// Fixed-window counter. INCR and EXPIRE run in one Lua call so a crash cannot leave a key without a TTL.
const RATE_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/** Returns true when the action is allowed, false when the limit is exceeded. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const n = (await getRedis().eval(RATE_LUA, 1, `rl:${key}`, windowSec)) as number;
  return n <= limit;
}

const TIB_TTL_SEC = 30 * 24 * 60 * 60;

/** Any token issued at or before this time is rejected. Mirrors users.tokensInvalidBefore. */
export async function setTokensInvalidBefore(userId: string, at: Date): Promise<void> {
  await getRedis().set(`tib:${userId}`, String(at.getTime()), 'EX', TIB_TTL_SEC);
}

export async function getTokensInvalidBefore(userId: string): Promise<number | null> {
  const v = await getRedis().get(`tib:${userId}`);
  return v ? Number(v) : null;
}

export type EnforcementAction = 'SUSPENDED' | 'DEACTIVATED' | 'TOKEN_REVOKED';
export interface EnforcementEvent {
  userId: string;
  action: EnforcementAction;
}

export async function publishEnforcement(event: EnforcementEvent): Promise<void> {
  await getRedis().publish(ENFORCEMENT_CHANNEL, JSON.stringify(event));
}
