import type { Types } from 'mongoose';
import { SUSPENSION_DAYS, TIER1_THRESHOLD, TIER2_THRESHOLD, type Role, type UserStatus } from '../constants.js';
import { withTx } from '../db.js';
import { AppError, forbiddenRole, notFound } from '../errors.js';
import { purgeAuthorFromFeedCache } from '../integrations.js';
import { BannedEmail, Post, User } from '../models/index.js';
import { publishEnforcement, setTokensInvalidBefore, type EnforcementAction } from '../redis.js';
import { emailHash, type IdLike } from '../util/helpers.js';
import { writeAudit } from './audit.js';
import { promoteReplacementAdmins } from './chat.js';

export type EnforcementDecision = 'NONE' | 'SUSPEND' | 'DEACTIVATE' | 'QUEUE';

/** Staff and Gold-badge accounts are never auto-suspended. They go to the admin queue instead (decision 6). */
export const isExempt = (u: { role: string; badge?: { type?: string | null } | null }): boolean =>
  u.role !== 'USER' || u.badge?.type === 'GOLD';

/**
 * What a new counted report should trigger, given the count AFTER it was added.
 * Pure on purpose, so the thresholds can be tested without a database.
 *  - Tier 1 fires only at exactly 10 and only for an ACTIVE account, so it fires once.
 *  - Tier 2 fires at 20 or more for any account that is not already DEACTIVATED.
 *  - Reports 11 to 19 do nothing.
 */
export function decideEnforcement(input: {
  reportCount: number;
  status: UserStatus;
  exempt: boolean;
}): EnforcementDecision {
  const { reportCount, status, exempt } = input;
  if (reportCount === TIER1_THRESHOLD && status === 'ACTIVE') return exempt ? 'QUEUE' : 'SUSPEND';
  if (reportCount >= TIER2_THRESHOLD && status !== 'DEACTIVATED') return exempt ? 'QUEUE' : 'DEACTIVATE';
  return 'NONE';
}

/**
 * Side effects that must follow any suspension or deactivation, after the database change has committed:
 * invalidate tokens, tell every socket server to drop the user's connections, and re-home group admin rights.
 * Each step is best effort. The status in the database is what the REST middleware and socket handshake check,
 * so a failure here delays disconnecting live sockets but never leaves the account usable.
 */
async function afterEnforcement(userId: string, at: Date, action: EnforcementAction): Promise<void> {
  await setTokensInvalidBefore(userId, at).catch((e) => console.error('tokensInvalidBefore failed', e));
  await publishEnforcement({ userId, action }).catch((e) => console.error('enforcement publish failed', e));
  await promoteReplacementAdmins(userId).catch((e) => console.error('admin promotion failed', e));
}

export interface SuspendOptions {
  userId: IdLike;
  actorId: IdLike | null; // null = automatic
  days?: number;
  reason?: string;
  reportCount?: number;
}

/** Returns false when the account was not ACTIVE (someone else already acted), true when it was suspended. */
export async function suspendUser(opts: SuspendOptions): Promise<boolean> {
  const now = new Date();
  const days = opts.days ?? SUSPENSION_DAYS;
  const until = new Date(now.getTime() + days * 86_400_000);

  const changed = await withTx(async (session) => {
    const res = await User.updateOne(
      { _id: opts.userId, status: 'ACTIVE' }, // conditional: a second concurrent call changes nothing
      { $set: { status: 'SUSPENDED', suspendedUntil: until, flaggedForAudit: true, tokensInvalidBefore: now } },
      { session },
    );
    if (res.modifiedCount !== 1) return false;
    const user = await User.findById(opts.userId).select('tenantDomain').session(session).lean();
    await writeAudit(
      {
        actorId: opts.actorId,
        action: 'USER_SUSPENDED',
        targetUserId: opts.userId,
        tenantDomain: user!.tenantDomain,
        metadata: { days, reason: opts.reason ?? null, reportCount: opts.reportCount ?? null, suspendedUntil: until },
      },
      session,
    );
    return true;
  });
  if (changed) await afterEnforcement(String(opts.userId), now, 'SUSPENDED');
  return changed;
}

export interface DeactivateOptions {
  userId: IdLike;
  actorId: IdLike | null;
  reason?: string;
  reportCount?: number;
}

/** Permanent. Hides the user's posts, bans their email, and records it. Returns false if already deactivated. */
export async function deactivateUser(opts: DeactivateOptions): Promise<boolean> {
  const now = new Date();
  const changed = await withTx(async (session) => {
    const res = await User.updateOne(
      { _id: opts.userId, status: { $ne: 'DEACTIVATED' } },
      { $set: { status: 'DEACTIVATED', deactivatedAt: now, suspendedUntil: null, tokensInvalidBefore: now } },
      { session },
    );
    if (res.modifiedCount !== 1) return false;
    const user = await User.findById(opts.userId).select('email tenantDomain').session(session).lean();
    await BannedEmail.updateOne(
      { emailHash: emailHash(user!.email) },
      {
        $setOnInsert: {
          userId: opts.userId,
          tenantDomain: user!.tenantDomain,
          reason: opts.actorId ? 'ADMIN_BAN' : 'TIER2_DEACTIVATION',
          bannedBy: opts.actorId ?? null,
          bannedAt: now,
        },
      },
      { upsert: true, session },
    );
    // Remembered by removedReason so a reversal restores exactly these posts and no others.
    await Post.updateMany(
      { authorId: opts.userId, moderationStatus: 'PUBLISHED' },
      { $set: { moderationStatus: 'REMOVED', removedReason: 'ACCOUNT_DEACTIVATED' } },
      { session },
    );
    await writeAudit(
      {
        actorId: opts.actorId,
        action: 'USER_DEACTIVATED',
        targetUserId: opts.userId,
        tenantDomain: user!.tenantDomain,
        metadata: { reason: opts.reason ?? null, reportCount: opts.reportCount ?? null },
      },
      session,
    );
    return true;
  });
  if (changed) {
    await afterEnforcement(String(opts.userId), now, 'DEACTIVATED');
    await purgeAuthorFromFeedCache(String(opts.userId)).catch((e) => console.error('feed purge failed', e));
  }
  return changed;
}

/**
 * Manual restore. A suspension can be lifted by a tenant admin. Reversing a deactivation needs a super admin,
 * lifts the email ban, restores the posts hidden by the deactivation, and resets the report count to zero
 * (otherwise the very next report would deactivate the account again).
 */
export async function restoreUser(userId: IdLike, actor: { id: IdLike; role: Role }): Promise<void> {
  const user = await User.findById(userId).select('status tenantDomain email').lean();
  if (!user) throw notFound('User');
  if (user.status === 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'This account is already active');

  if (user.status === 'SUSPENDED') {
    await withTx(async (session) => {
      const res = await User.updateOne({ _id: userId, status: 'SUSPENDED' }, { $set: { status: 'ACTIVE', suspendedUntil: null } }, { session });
      if (res.modifiedCount !== 1) throw new AppError(409, 'INVALID_STATE', 'This account is no longer suspended');
      await writeAudit({ actorId: actor.id, action: 'USER_RESTORED', targetUserId: userId, tenantDomain: user.tenantDomain }, session);
    });
    return;
  }

  if (actor.role !== 'SUPER_ADMIN') throw forbiddenRole();
  await withTx(async (session) => {
    const res = await User.updateOne(
      { _id: userId, status: 'DEACTIVATED' },
      { $set: { status: 'ACTIVE', deactivatedAt: null, reportCount: 0, flaggedForAudit: false } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new AppError(409, 'INVALID_STATE', 'This account is no longer deactivated');
    await BannedEmail.deleteMany({ emailHash: emailHash(user.email) }, { session });
    await Post.updateMany(
      { authorId: userId, removedReason: 'ACCOUNT_DEACTIVATED' },
      { $set: { moderationStatus: 'PUBLISHED', removedReason: null } },
      { session },
    );
    await writeAudit({ actorId: actor.id, action: 'USER_REACTIVATED', targetUserId: userId, tenantDomain: user.tenantDomain }, session);
    await writeAudit({ actorId: actor.id, action: 'EMAIL_UNBANNED', targetUserId: userId, tenantDomain: user.tenantDomain }, session);
  });
  await purgeAuthorFromFeedCache(String(userId)).catch((e) => console.error('feed purge failed', e));
}

/**
 * Auto-restore job body. Safe to run repeatedly and from several workers at once:
 * each user is updated with a conditional filter, so only one run restores (and audits) them.
 * The PRD says access returns "if no additional severe violations occur" but never defines that, so this restores
 * unconditionally. tokensInvalidBefore stays set, so old tokens remain dead and a fresh login works.
 */
export async function restoreExpiredSuspensions(now: Date = new Date(), batch = 500): Promise<number> {
  const due = await User.find({ status: 'SUSPENDED', suspendedUntil: { $lte: now } })
    .select('_id tenantDomain')
    .limit(batch)
    .lean();
  let restored = 0;
  for (const u of due) {
    await withTx(async (session) => {
      const res = await User.updateOne(
        { _id: u._id, status: 'SUSPENDED', suspendedUntil: { $lte: now } },
        { $set: { status: 'ACTIVE', suspendedUntil: null } },
        { session },
      );
      if (res.modifiedCount !== 1) return;
      await writeAudit(
        { actorId: null, action: 'USER_RESTORED', targetUserId: u._id as Types.ObjectId, tenantDomain: u.tenantDomain, metadata: { auto: true } },
        session,
      );
      restored++;
    });
  }
  return restored;
}
