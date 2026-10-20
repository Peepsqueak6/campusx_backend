import { AUDIT_ACTIONS, ROLE_RANK, type AuditAction, type BadgeType, type Role } from '../constants.js';
import { AppError, forbiddenRole, notFound } from '../errors.js';
import { AdminAuditLog, BannedTerm, Report, User } from '../models/index.js';
import { clampLimit, decodeCursor, encodeCursor, type IdLike } from '../util/helpers.js';
import { writeAudit } from './audit.js';
import { compileTerm, invalidateTermCache } from './contentFilter.js';
import { deactivateUser, suspendUser } from './enforcement.js';
import { tenantScope, type Actor } from './moderation.js';

const SAFE_FIELDS =
  'handle displayName tenantDomain role status badge reportCount flaggedForAudit suspendedUntil deactivatedAt createdAt';

/**
 * Loads an account the actor is allowed to touch.
 * `outrank` = the actor must hold a strictly higher role (equal or higher roles are protected).
 */
async function loadTarget(actor: Actor, id: IdLike, outrank: boolean) {
  const target = await User.findById(id).select(`${SAFE_FIELDS} email`).lean();
  const scope = tenantScope(actor);
  if (!target || (scope !== null && target.tenantDomain !== scope)) throw notFound('User');
  if (outrank && ROLE_RANK[actor.role] <= ROLE_RANK[target.role as Role]) throw forbiddenRole();
  return target;
}

export async function listUsers(
  actor: Actor,
  q: { status?: string; flagged?: string; q?: string; tenantDomain?: string; cursor?: string; limit?: unknown },
) {
  const limit = clampLimit(q.limit, 25, 100);
  const scope = tenantScope(actor, q.tenantDomain);
  const filter: Record<string, unknown> = {};
  if (scope !== null) filter.tenantDomain = scope;
  if (q.status) filter.status = q.status;
  if (q.flagged === 'true') filter.flaggedForAudit = true;
  if (q.q) {
    const prefix = new RegExp(`^${q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    filter.$or = [{ handle: prefix }, { displayName: prefix }];
  }
  if (q.cursor) filter._id = { $lt: decodeCursor(q.cursor).id };
  const rows = await User.find(filter).select(SAFE_FIELDS).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last._id) : null };
}

export async function getUser(actor: Actor, id: IdLike) {
  const user = await loadTarget(actor, id, false);
  const { email: _email, ...safe } = user; // moderators do not need the email address
  const [reports, audit] = await Promise.all([
    Report.find({ targetUserId: user._id }).sort({ createdAt: -1 }).limit(20).lean(),
    AdminAuditLog.find({ targetUserId: user._id }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  return { user: safe, reports, audit };
}

export async function suspendManually(actor: Actor, id: IdLike, days: number, reason: string) {
  const target = await loadTarget(actor, id, true);
  const done = await suspendUser({ userId: target._id, actorId: actor.id, days, reason });
  if (!done) throw new AppError(409, 'INVALID_STATE', 'Only an active account can be suspended');
}

export async function deactivateManually(actor: Actor, id: IdLike, reason: string) {
  const target = await loadTarget(actor, id, true);
  const done = await deactivateUser({ userId: target._id, actorId: actor.id, reason });
  if (!done) throw new AppError(409, 'INVALID_STATE', 'This account is already deactivated');
}

/** Used by the restore route: checks scope and rank, then lets the enforcement service decide what is allowed. */
export async function assertCanRestore(actor: Actor, id: IdLike) {
  return loadTarget(actor, id, true);
}

/**
 * Appoints moderators and tenant admins. SUPER_ADMIN cannot be granted through the API on purpose:
 * create those directly in the database.
 */
export async function setRole(actor: Actor, id: IdLike, role: Role) {
  if (String(actor.id) === String(id)) throw new AppError(422, 'VALIDATION_FAILED', 'You cannot change your own role');
  if (role === 'SUPER_ADMIN') throw new AppError(422, 'VALIDATION_FAILED', 'SUPER_ADMIN cannot be granted through the API');
  const target = await loadTarget(actor, id, true);
  if (target.role === role) return;
  await User.updateOne({ _id: target._id }, { $set: { role } });
  await writeAudit({
    actorId: actor.id,
    action: 'ROLE_CHANGED',
    targetUserId: target._id,
    tenantDomain: target.tenantDomain,
    metadata: { from: target.role, to: role },
  });
}

export async function issueBadge(actor: Actor, id: IdLike, type: Exclude<BadgeType, 'NONE'>) {
  if (type === 'GOLD' && actor.role !== 'SUPER_ADMIN') throw forbiddenRole(); // decision 11
  const target = await loadTarget(actor, id, false);
  if (target.status === 'DEACTIVATED') throw new AppError(409, 'INVALID_STATE', 'This account is deactivated');
  await User.updateOne(
    { _id: target._id },
    { $set: { badge: { type, issuedAt: new Date(), issuedBy: actor.id, revokedAt: null } } },
  );
  await writeAudit({
    actorId: actor.id,
    action: 'BADGE_ISSUED',
    targetUserId: target._id,
    tenantDomain: target.tenantDomain,
    metadata: { badge: type, previous: target.badge?.type ?? 'NONE' },
  });
}

export async function revokeBadge(actor: Actor, id: IdLike) {
  const target = await loadTarget(actor, id, false);
  const current = (target.badge?.type ?? 'NONE') as BadgeType;
  if (current === 'NONE') throw new AppError(409, 'INVALID_STATE', 'This account has no badge');
  if (current === 'GOLD' && actor.role !== 'SUPER_ADMIN') throw forbiddenRole();
  await User.updateOne({ _id: target._id }, { $set: { 'badge.type': 'NONE', 'badge.revokedAt': new Date() } });
  await writeAudit({
    actorId: actor.id,
    action: 'BADGE_REVOKED',
    targetUserId: target._id,
    tenantDomain: target.tenantDomain,
    metadata: { badge: current },
  });
}

// ---------------------------------------------------------------- banned terms

export async function listTerms(actor: Actor) {
  const scope = tenantScope(actor);
  const filter = scope === null ? { active: true } : { active: true, $or: [{ tenantDomain: scope }, { tenantDomain: null }] };
  return BannedTerm.find(filter).sort({ createdAt: -1 }).lean();
}

export async function addTerm(actor: Actor, input: { term: string; matchType: 'WORD' | 'REGEX'; global?: boolean }) {
  if (input.global && actor.role !== 'SUPER_ADMIN') throw forbiddenRole();
  if (!compileTerm(input.term, input.matchType)) throw new AppError(422, 'VALIDATION_FAILED', 'That pattern is not a valid regular expression');
  const doc = await BannedTerm.create({
    term: input.term,
    matchType: input.matchType,
    tenantDomain: input.global ? null : actor.tenantDomain,
    addedBy: actor.id,
  });
  invalidateTermCache();
  return doc.toObject();
}

export async function deactivateTerm(actor: Actor, id: IdLike) {
  const term = await BannedTerm.findById(id).lean();
  const scope = tenantScope(actor);
  if (!term || !term.active) throw notFound('Term');
  if (term.tenantDomain === null ? actor.role !== 'SUPER_ADMIN' : scope !== null && term.tenantDomain !== scope) {
    throw term.tenantDomain === null ? forbiddenRole() : notFound('Term');
  }
  await BannedTerm.updateOne({ _id: id }, { $set: { active: false } });
  invalidateTermCache();
}

// ---------------------------------------------------------------- audit log

export async function listAudit(
  actor: Actor,
  q: { targetUserId?: string; action?: string; cursor?: string; limit?: unknown; tenantDomain?: string },
) {
  const limit = clampLimit(q.limit, 25, 100);
  const scope = tenantScope(actor, q.tenantDomain);
  const filter: Record<string, unknown> = {};
  if (scope !== null) filter.tenantDomain = scope;
  if (q.targetUserId) filter.targetUserId = q.targetUserId;
  if (q.action) {
    if (!(AUDIT_ACTIONS as readonly string[]).includes(q.action)) throw new AppError(422, 'VALIDATION_FAILED', 'Unknown action');
    filter.action = q.action as AuditAction;
  }
  if (q.cursor) filter._id = { $lt: decodeCursor(q.cursor).id };
  const rows = await AdminAuditLog.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last._id) : null };
}
