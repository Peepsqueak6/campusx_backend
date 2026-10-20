import type { Types } from 'mongoose';
import { MESSAGE_CONTEXT_WINDOW, type Role } from '../constants.js';
import { withTx } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { purgePostFromFeedCache } from '../integrations.js';
import { Message, ModerationQueueItem, Post, Report, User } from '../models/index.js';
import { emitToConversation } from '../realtime/bus.js';
import { clampLimit, decodeCursor, encodeCursor, toObjectId, type IdLike } from '../util/helpers.js';
import { serializeMessage } from './chat.js';
import { writeAudit } from './audit.js';

export interface Actor {
  id: string;
  role: Role;
  tenantDomain: string;
}

/** Moderators and tenant admins see only their campus. Super admins see all, or one via ?tenantDomain=. */
export const tenantScope = (actor: Actor, requested?: string): string | null =>
  actor.role === 'SUPER_ADMIN' ? (requested ?? null) : actor.tenantDomain;

async function loadItem(actor: Actor, id: IdLike) {
  const item = await ModerationQueueItem.findById(id).lean();
  const scope = tenantScope(actor);
  // 404 rather than 403 for another campus, so queue ids cannot be probed.
  if (!item || (scope !== null && item.tenantDomain !== scope)) throw notFound('Queue item');
  return item;
}

export async function listQueue(
  actor: Actor,
  q: { status?: string; source?: string; tenantDomain?: string; cursor?: string; limit?: unknown },
) {
  const limit = clampLimit(q.limit, 25, 100);
  const scope = tenantScope(actor, q.tenantDomain);
  const and: Record<string, unknown>[] = [{ status: q.status ?? 'PENDING' }];
  if (scope !== null) and.push({ tenantDomain: scope });
  if (q.source) and.push({ source: q.source });
  if (q.cursor) {
    const { date, id } = decodeCursor(q.cursor);
    and.push({ $or: [{ createdAt: { $gt: date } }, { createdAt: date, _id: { $gt: id } }] });
  }
  const rows = await ModerationQueueItem.find({ $and: and })
    .sort({ createdAt: 1, _id: 1 }) // oldest first
    .limit(limit + 1)
    .lean();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last._id) : null };
}

/** One item with the content and reports behind it. Opening a message's context is written to the audit log. */
export async function getQueueItem(actor: Actor, id: IdLike) {
  const item = await loadItem(actor, id);
  const reports = await Report.find({ _id: { $in: item.reportIds } })
    .select('reporterId reason details counted createdAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  let content: unknown = null;
  if (item.targetType === 'POST' && item.targetPostId) {
    content = await Post.findById(item.targetPostId).lean();
  } else if (item.targetType === 'MESSAGE' && item.targetMessageId) {
    const msg = await Message.findById(item.targetMessageId).lean();
    if (msg) {
      // Moderators see the reported message and a few around it, and no more of a private conversation.
      const before = await Message.find({ conversationId: msg.conversationId, _id: { $lt: msg._id } })
        .sort({ _id: -1 })
        .limit(MESSAGE_CONTEXT_WINDOW)
        .lean();
      const after = await Message.find({ conversationId: msg.conversationId, _id: { $gt: msg._id } })
        .sort({ _id: 1 })
        .limit(MESSAGE_CONTEXT_WINDOW)
        .lean();
      content = {
        message: serializeMessage(msg as never),
        context: [...before.reverse(), ...after].map((m) => serializeMessage(m as never)),
      };
      await writeAudit({
        actorId: actor.id,
        action: 'MESSAGE_CONTEXT_VIEWED',
        targetUserId: item.targetUserId,
        targetId: msg._id,
        tenantDomain: item.tenantDomain,
        metadata: { queueItemId: String(item._id) },
      });
    }
  } else if (item.targetType === 'USER') {
    content = await User.findById(item.targetUserId)
      .select('handle displayName tenantDomain role status badge reportCount flaggedForAudit suspendedUntil')
      .lean();
  }
  return { item, reports, content };
}

/** Keeps the content (or dismisses a user flag). Publishes a post the profanity filter was holding. */
export async function approveItem(actor: Actor, id: IdLike, note?: string) {
  const item = await loadItem(actor, id);
  await withTx(async (session) => {
    const res = await ModerationQueueItem.updateOne(
      { _id: item._id, status: 'PENDING' },
      { $set: { status: 'APPROVED', resolution: 'CONTENT_KEPT', reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: note ?? null } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new AppError(409, 'QUEUE_ITEM_RESOLVED', 'This item was already reviewed');
    if (item.targetType === 'POST' && item.targetPostId) {
      await Post.updateOne(
        { _id: item.targetPostId, moderationStatus: 'PENDING_REVIEW' },
        { $set: { moderationStatus: 'PUBLISHED' } },
        { session },
      );
    }
    await writeAudit(
      {
        actorId: actor.id,
        action: 'POST_APPROVED',
        targetUserId: item.targetUserId,
        targetId: (item.targetPostId ?? item.targetMessageId ?? item._id) as Types.ObjectId,
        tenantDomain: item.tenantDomain,
        metadata: { queueItemId: String(item._id), targetType: item.targetType, note: note ?? null },
      },
      session,
    );
  });
}

/**
 * Removes the reported content. Posts are hidden (moderationStatus REMOVED) rather than erased, so the
 * reports keep their evidence. Messages are soft-deleted for everyone.
 */
export async function removeItem(actor: Actor, id: IdLike, note?: string) {
  const item = await loadItem(actor, id);
  if (item.targetType === 'USER') {
    throw new AppError(422, 'NOT_CONTENT', 'This item is about an account. Use the user routes to act on it');
  }
  await withTx(async (session) => {
    const res = await ModerationQueueItem.updateOne(
      { _id: item._id, status: 'PENDING' },
      { $set: { status: 'DELETED', resolution: 'CONTENT_REMOVED', reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: note ?? null } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new AppError(409, 'QUEUE_ITEM_RESOLVED', 'This item was already reviewed');
    if (item.targetType === 'POST' && item.targetPostId) {
      await Post.updateOne(
        { _id: item.targetPostId },
        { $set: { moderationStatus: 'REMOVED', removedReason: 'MODERATION' } },
        { session },
      );
    } else if (item.targetType === 'MESSAGE' && item.targetMessageId) {
      await Message.updateOne(
        { _id: item.targetMessageId, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: toObjectId(actor.id) } },
        { session },
      );
    }
    await writeAudit(
      {
        actorId: actor.id,
        action: 'POST_DELETED',
        targetUserId: item.targetUserId,
        targetId: (item.targetPostId ?? item.targetMessageId) as Types.ObjectId,
        tenantDomain: item.tenantDomain,
        metadata: { queueItemId: String(item._id), targetType: item.targetType, note: note ?? null },
      },
      session,
    );
  });

  // After the commit: caches and live clients. These never undo the moderation decision.
  if (item.targetType === 'POST' && item.targetPostId) {
    await purgePostFromFeedCache(String(item.targetPostId)).catch((e) => console.error('feed purge failed', e));
  } else if (item.targetType === 'MESSAGE' && item.targetMessageId) {
    const msg = await Message.findById(item.targetMessageId).select('conversationId').lean();
    if (msg) {
      emitToConversation(String(msg.conversationId), 'MESSAGE_DELETED', {
        conversationId: String(msg.conversationId),
        messageId: String(item.targetMessageId),
      });
    }
  }
}
