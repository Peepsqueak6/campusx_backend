import { Types } from 'mongoose';
import { config } from '../config.js';
import {
  DECLINE_COOLDOWN_DAYS,
  MAX_GROUP_MEMBERS,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_TYPES,
  MESSAGE_MAX_CHARS,
  MESSAGE_RATE,
  REQUEST_MESSAGE_LIMIT,
  GROUP_NAME_MAX,
} from '../constants.js';
import { isDuplicateKey } from '../db.js';
import { AppError, notFound, notParticipant } from '../errors.js';
import { Conversation, Message, User, UserBlock, isMutualFollow } from '../models/index.js';
import {
  emitToConversation,
  emitToUser,
  joinUserToConversation,
  removeUserFromConversation,
} from '../realtime/bus.js';
import { rateLimit } from '../redis.js';
import {
  clampLimit,
  decodeCursor,
  directKey,
  encodeCursor,
  sameId,
  toObjectId,
  type IdLike,
} from '../util/helpers.js';

// ---------------------------------------------------------------- helpers

type MessageLean = {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  type: string;
  text?: string | null;
  media?: unknown;
  clientMessageId: string;
  deletedAt?: Date | null;
  createdAt: Date;
};

/** What clients receive from REST. Deleted messages keep their place but lose their content. */
export function serializeMessage(m: MessageLean) {
  const base = {
    id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: String(m.senderId),
    type: m.type,
    clientMessageId: m.clientMessageId,
    createdAt: m.createdAt,
  };
  if (m.deletedAt) return { ...base, deleted: true, text: '', media: null };
  return { ...base, deleted: false, text: m.text ?? '', media: m.media ?? null };
}

/** Payload of the NEW_MESSAGE socket event. */
export const newMessagePayload = (m: MessageLean) => ({
  messageId: String(m._id),
  conversationId: String(m.conversationId),
  senderId: String(m.senderId),
  type: m.type,
  text: m.text ?? '',
  media: m.media ?? null,
  clientMessageId: m.clientMessageId,
  timestamp: m.createdAt.toISOString(),
});

export async function isBlockedEitherWay(a: IdLike, b: IdLike): Promise<boolean> {
  const n = await UserBlock.countDocuments({
    $or: [
      { blockerId: a, blockedId: b },
      { blockerId: b, blockedId: a },
    ],
  });
  return n > 0;
}

async function displayNames(ids: IdLike[]): Promise<Map<string, string>> {
  const users = await User.find({ _id: { $in: ids } }).select('displayName status').lean();
  return new Map(users.map((u) => [String(u._id), u.status === 'DEACTIVATED' ? 'Deactivated account' : u.displayName]));
}

const recipientUnavailable = () =>
  new AppError(403, 'RECIPIENT_UNAVAILABLE', 'This account is no longer available');

async function getConversationFor(userId: IdLike, conversationId: IdLike) {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw notFound('Conversation');
  if (!conv.participantIds.some((p) => sameId(p, userId))) throw notParticipant();
  return conv;
}

async function requireGroupAdmin(conversationId: IdLike, userId: IdLike) {
  const conv = await getConversationFor(userId, conversationId);
  if (!conv.isGroup) throw new AppError(422, 'NOT_A_GROUP', 'This is not a group chat');
  if (!conv.adminIds.some((a) => sameId(a, userId))) {
    throw new AppError(403, 'NOT_GROUP_ADMIN', 'Only group admins can do this');
  }
  return conv;
}

// ---------------------------------------------------------------- messages

export async function assertMessageRateLimit(userId: IdLike): Promise<void> {
  const ok = await rateLimit(`msg:${userId}`, MESSAGE_RATE.limit, MESSAGE_RATE.windowSec);
  if (!ok) throw new AppError(429, 'RATE_LIMITED', 'You are sending messages too fast');
}

export interface SendMessageInput {
  conversationId: IdLike;
  senderId: IdLike;
  clientMessageId: string;
  text?: string;
  media?: { url: string; mimeType: string; sizeBytes: number; width?: number; height?: number; durationSec?: number } | null;
}

/** Stores the message, updates the inbox preview and broadcasts it. Safe to call twice with the same clientMessageId. */
export async function sendMessage(input: SendMessageInput) {
  await assertMessageRateLimit(input.senderId);

  const text = (input.text ?? '').trim();
  if (text.length > MESSAGE_MAX_CHARS) {
    throw new AppError(422, 'MESSAGE_TOO_LONG', `Messages are limited to ${MESSAGE_MAX_CHARS} characters`);
  }
  const media = input.media ?? null;
  if (!text && !media) throw new AppError(422, 'EMPTY_MESSAGE', 'A message needs text or an attachment');
  if (media) {
    const okUrl = media.url.startsWith(`${config.media.baseUrl}/`);
    if (!okUrl || !MEDIA_MIME_TYPES.includes(media.mimeType) || media.sizeBytes > MEDIA_MAX_BYTES || media.sizeBytes <= 0) {
      throw new AppError(422, 'INVALID_MEDIA', 'Attachment is not allowed');
    }
  }

  const conv = await getConversationFor(input.senderId, input.conversationId);

  if (conv.status === 'DECLINED') {
    throw new AppError(403, 'CHAT_REQUEST_DECLINED', 'This message request was declined');
  }
  if (conv.status === 'REQUESTED') {
    const isRequester = sameId(conv.requestedBy, input.senderId);
    const sent = isRequester
      ? await Message.countDocuments({ conversationId: conv._id, senderId: input.senderId, type: { $ne: 'SYSTEM' } })
      : Infinity;
    if (!isRequester || sent >= REQUEST_MESSAGE_LIMIT) {
      throw new AppError(409, 'CHAT_REQUEST_PENDING', 'Waiting for the other person to accept your message request');
    }
  }
  if (!conv.isGroup) {
    const otherId = conv.participantIds.find((p) => !sameId(p, input.senderId))!;
    const other = await User.findById(otherId).select('status').lean();
    if (!other || other.status === 'DEACTIVATED') throw recipientUnavailable();
    if (await isBlockedEitherWay(input.senderId, otherId)) {
      throw new AppError(403, 'USER_BLOCKED', 'You cannot message this user');
    }
  }

  const dupFilter = {
    conversationId: conv._id,
    senderId: input.senderId,
    clientMessageId: input.clientMessageId,
  };
  const existing = await Message.findOne(dupFilter).lean();
  if (existing) return { message: existing as MessageLean, duplicate: true };

  let message: MessageLean;
  try {
    const created = await Message.create({
      ...dupFilter,
      type: media ? 'MEDIA' : 'TEXT',
      text,
      media,
    });
    message = created.toObject() as MessageLean;
  } catch (err) {
    if (isDuplicateKey(err)) {
      const winner = await Message.findOne(dupFilter).lean();
      if (winner) return { message: winner as MessageLean, duplicate: true };
    }
    throw err;
  }

  await touchConversation(message);
  emitToConversation(String(conv._id), 'NEW_MESSAGE', newMessagePayload(message));
  return { message, duplicate: false };
}

/** Moves the inbox preview forward only. A slower, older message never overwrites a newer preview. */
async function touchConversation(m: MessageLean): Promise<void> {
  await Conversation.updateOne(
    { _id: m.conversationId, $or: [{ lastMessage: null }, { 'lastMessage.messageId': { $lt: m._id } }] },
    {
      $set: {
        lastMessage: {
          messageId: m._id,
          senderId: m.senderId,
          preview: m.type === 'MEDIA' ? '' : (m.text ?? '').slice(0, 100),
          sentAt: m.createdAt,
        },
        lastMessageAt: m.createdAt,
      },
    },
  );
}

async function createSystemMessage(conversationId: IdLike, actorId: IdLike, text: string): Promise<void> {
  const created = await Message.create({
    conversationId,
    senderId: actorId,
    type: 'SYSTEM',
    text,
    clientMessageId: `sys:${new Types.ObjectId()}`,
  });
  const message = created.toObject() as MessageLean;
  await touchConversation(message);
  emitToConversation(String(conversationId), 'NEW_MESSAGE', newMessagePayload(message));
}

export async function listMessages(conversationId: IdLike, userId: IdLike, before?: string, limitRaw?: unknown) {
  await getConversationFor(userId, conversationId);
  const limit = clampLimit(limitRaw, 30, 50);
  const filter: Record<string, unknown> = { conversationId: toObjectId(conversationId) };
  if (before) {
    if (!Types.ObjectId.isValid(before)) throw new AppError(422, 'VALIDATION_FAILED', 'Invalid cursor');
    filter._id = { $lt: new Types.ObjectId(before) };
  }
  const rows = (await Message.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()) as MessageLean[];
  const page = rows.slice(0, limit);
  return {
    items: page.map(serializeMessage),
    nextBefore: rows.length > limit ? String(page[page.length - 1]!._id) : null,
  };
}

export async function deleteMessage(conversationId: IdLike, messageId: IdLike, userId: IdLike): Promise<void> {
  const conv = await getConversationFor(userId, conversationId);
  const msg = await Message.findOne({ _id: messageId, conversationId: conv._id }).lean();
  if (!msg) throw notFound('Message');
  if (msg.type === 'SYSTEM') throw new AppError(422, 'NOT_DELETABLE', 'System messages cannot be deleted');
  const isAdmin = conv.isGroup && conv.adminIds.some((a) => sameId(a, userId));
  if (!sameId(msg.senderId, userId) && !isAdmin) {
    throw new AppError(403, 'NOT_MESSAGE_OWNER', 'Only the sender or a group admin can delete this message');
  }
  if (msg.deletedAt) return;
  await Message.updateOne({ _id: msg._id, deletedAt: null }, { $set: { deletedAt: new Date(), deletedBy: userId } });
  emitToConversation(String(conv._id), 'MESSAGE_DELETED', {
    conversationId: String(conv._id),
    messageId: String(msg._id),
  });
}

/** Moves the member's read pointer forward. Returns true when it moved (so a receipt should be sent). */
export async function markRead(conversationId: IdLike, userId: IdLike, messageId: IdLike) {
  const conv = await getConversationFor(userId, conversationId);
  const msg = await Message.findOne({ _id: messageId, conversationId: conv._id }).select('_id').lean();
  if (!msg) throw notFound('Message');
  const res = await Conversation.updateOne(
    {
      _id: conv._id,
      participants: {
        $elemMatch: {
          userId,
          $or: [{ lastReadMessageId: null }, { lastReadMessageId: { $lt: msg._id } }],
        },
      },
    },
    { $set: { 'participants.$.lastReadMessageId': msg._id } },
  );
  const moved = res.modifiedCount === 1;
  if (moved) {
    emitToConversation(String(conv._id), 'READ_RECEIPT', {
      conversationId: String(conv._id),
      userId: String(userId),
      lastReadMessageId: String(msg._id),
      readAt: new Date().toISOString(),
    });
  }
  return moved;
}

// ---------------------------------------------------------------- direct chats and requests

export async function createOrGetDirect(meId: IdLike, otherId: IdLike) {
  if (sameId(meId, otherId)) throw new AppError(422, 'CANNOT_MESSAGE_SELF', 'You cannot message yourself');
  const other = await User.findById(otherId).select('status').lean();
  if (!other) throw notFound('User');
  if (other.status === 'DEACTIVATED') throw recipientUnavailable();
  if (await isBlockedEitherWay(meId, otherId)) throw new AppError(403, 'USER_BLOCKED', 'You cannot message this user');

  const key = directKey(meId, otherId);
  const existing = await Conversation.findOne({ directKey: key });
  if (existing) {
    if (existing.status !== 'DECLINED') return { conversation: existing.toObject(), created: false };

    // A declined request cannot be re-sent by the requester for 30 days. The decliner may reopen at any time.
    const coolingDown =
      existing.declinedAt && Date.now() - existing.declinedAt.getTime() < DECLINE_COOLDOWN_DAYS * 86_400_000;
    if (coolingDown && sameId(existing.requestedBy, meId)) {
      throw new AppError(403, 'CHAT_REQUEST_DECLINED', 'This message request was declined');
    }
    const mutual = await isMutualFollow(meId, otherId);
    existing.status = mutual ? 'ACTIVE' : 'REQUESTED';
    existing.requestedBy = mutual ? null : toObjectId(meId);
    existing.declinedAt = null;
    await existing.save();
    if (!mutual) emitToUser(String(otherId), 'CONVERSATION_REQUEST', { conversationId: String(existing._id), from: String(meId) });
    return { conversation: existing.toObject(), created: false };
  }

  const mutual = await isMutualFollow(meId, otherId);
  try {
    const created = await Conversation.create({
      isGroup: false,
      createdBy: meId,
      participantIds: [meId, otherId],
      participants: [{ userId: meId }, { userId: otherId }],
      directKey: key,
      status: mutual ? 'ACTIVE' : 'REQUESTED',
      requestedBy: mutual ? null : meId,
      memberCount: 2,
    });
    const id = String(created._id);
    joinUserToConversation(String(meId), id);
    joinUserToConversation(String(otherId), id);
    if (!mutual) emitToUser(String(otherId), 'CONVERSATION_REQUEST', { conversationId: id, from: String(meId) });
    return { conversation: created.toObject(), created: true };
  } catch (err) {
    if (isDuplicateKey(err)) {
      // Both users opened the chat at the same moment. Return the one that won.
      const winner = await Conversation.findOne({ directKey: key });
      if (winner) return { conversation: winner.toObject(), created: false };
    }
    throw err;
  }
}

export async function respondToRequest(conversationId: IdLike, userId: IdLike, accept: boolean) {
  const conv = await getConversationFor(userId, conversationId);
  if (conv.status !== 'REQUESTED' || sameId(conv.requestedBy, userId)) {
    throw new AppError(409, 'INVALID_STATE', 'There is no pending request for you to answer');
  }
  const set = accept ? { status: 'ACTIVE' } : { status: 'DECLINED', declinedAt: new Date() };
  const res = await Conversation.updateOne({ _id: conv._id, status: 'REQUESTED' }, { $set: set });
  if (res.modifiedCount !== 1) throw new AppError(409, 'INVALID_STATE', 'This request was already answered');
  if (accept) {
    emitToConversation(String(conv._id), 'CONVERSATION_UPDATED', {
      conversationId: String(conv._id),
      change: 'ACCEPTED',
      userId: String(userId),
    });
  }
}

// ---------------------------------------------------------------- inbox and details

export async function listInbox(userId: IdLike, query: { cursor?: string; limit?: unknown; status?: string }) {
  const limit = clampLimit(query.limit, 20, 50);
  const mine = toObjectId(userId);
  const statusFilter =
    query.status === 'REQUESTED'
      ? { status: 'REQUESTED', requestedBy: { $ne: mine } } // requests sent to me
      : { $or: [{ status: 'ACTIVE' }, { status: 'REQUESTED', requestedBy: mine }] }; // my chats and requests I sent

  const and: Record<string, unknown>[] = [{ participantIds: mine }, statusFilter];
  if (query.cursor) {
    const { date, id } = decodeCursor(query.cursor);
    and.push({ $or: [{ lastMessageAt: { $lt: date } }, { lastMessageAt: date, _id: { $lt: id } }] });
  }
  const rows = await Conversation.find({ $and: and })
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const page = rows.slice(0, limit);

  const items = await Promise.all(
    page.map(async (c) => {
      const me = c.participants.find((p) => sameId(p.userId, userId));
      const unread = await Message.countDocuments(
        {
          conversationId: c._id,
          senderId: { $ne: mine },
          type: { $ne: 'SYSTEM' },
          deletedAt: null,
          ...(me?.lastReadMessageId ? { _id: { $gt: me.lastReadMessageId } } : {}),
        },
        { limit: 99 },
      );
      return {
        id: String(c._id),
        isGroup: c.isGroup,
        groupName: c.groupName,
        groupAvatarUrl: c.groupAvatarUrl,
        status: c.status,
        requestedBy: c.requestedBy ? String(c.requestedBy) : null,
        memberCount: c.memberCount,
        otherUserId: c.isGroup ? null : String(c.participantIds.find((p) => !sameId(p, userId))),
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        unreadCount: unread,
      };
    }),
  );
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.lastMessageAt, last._id) : null };
}

export async function getConversationDetails(conversationId: IdLike, userId: IdLike) {
  const conv = await getConversationFor(userId, conversationId);
  const users = await User.find({ _id: { $in: conv.participantIds } })
    .select('handle displayName avatarUrl badge status')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const members = conv.participants.map((p) => {
    const u = byId.get(String(p.userId));
    const gone = !u || u.status === 'DEACTIVATED';
    return {
      userId: String(p.userId),
      handle: gone ? null : u.handle,
      displayName: gone ? 'Deactivated account' : u.displayName,
      avatarUrl: gone ? null : (u.avatarUrl ?? null),
      badge: gone ? 'NONE' : (u.badge?.type ?? 'NONE'),
      joinedAt: p.joinedAt,
      isAdmin: conv.adminIds.some((a) => sameId(a, p.userId)),
      lastReadMessageId: p.lastReadMessageId ? String(p.lastReadMessageId) : null,
    };
  });
  return {
    id: String(conv._id),
    isGroup: conv.isGroup,
    groupName: conv.groupName,
    groupAvatarUrl: conv.groupAvatarUrl,
    status: conv.status,
    requestedBy: conv.requestedBy ? String(conv.requestedBy) : null,
    memberCount: conv.memberCount,
    createdBy: String(conv.createdBy),
    members,
  };
}

// ---------------------------------------------------------------- groups

export async function createGroup(meId: IdLike, name: string, memberIds: IdLike[]) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > GROUP_NAME_MAX) {
    throw new AppError(422, 'VALIDATION_FAILED', `Group name must be 1 to ${GROUP_NAME_MAX} characters`);
  }
  const others = [...new Set(memberIds.map(String))].filter((id) => id !== String(meId));
  if (others.length < 1) throw new AppError(422, 'GROUP_NEEDS_MEMBERS', 'Add at least one other member');
  if (others.length + 1 > MAX_GROUP_MEMBERS) throw new AppError(409, 'GROUP_FULL', `Groups are limited to ${MAX_GROUP_MEMBERS} members`);

  await assertCanBeAdded(meId, others);

  const all = [String(meId), ...others].map(toObjectId);
  const created = await Conversation.create({
    isGroup: true,
    groupName: trimmed,
    createdBy: meId,
    adminIds: [meId],
    participantIds: all,
    participants: all.map((userId) => ({ userId })),
    memberCount: all.length,
  });
  const id = String(created._id);
  for (const uid of all) joinUserToConversation(String(uid), id);
  const names = await displayNames([meId]);
  await createSystemMessage(id, meId, `${names.get(String(meId))} created the group "${trimmed}"`);
  emitToConversation(id, 'CONVERSATION_UPDATED', { conversationId: id, change: 'MEMBER_ADDED', userIds: all.map(String) });
  return created.toObject();
}

/** Members must exist, not be deactivated, and not have a block with the person adding them. */
async function assertCanBeAdded(adderId: IdLike, ids: string[]): Promise<void> {
  const users = await User.find({ _id: { $in: ids } }).select('status').lean();
  if (users.length !== ids.length) throw new AppError(422, 'UNKNOWN_MEMBER', 'One or more users do not exist');
  if (users.some((u) => u.status === 'DEACTIVATED')) throw recipientUnavailable();
  const blocked = await UserBlock.countDocuments({
    $or: [
      { blockerId: adderId, blockedId: { $in: ids } },
      { blockedId: adderId, blockerId: { $in: ids } },
    ],
  });
  if (blocked > 0) throw new AppError(403, 'USER_BLOCKED', 'You cannot add one or more of these users');
}

export async function updateGroup(conversationId: IdLike, adminId: IdLike, patch: { name?: string; avatarUrl?: string | null }) {
  const conv = await requireGroupAdmin(conversationId, adminId);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n || n.length > GROUP_NAME_MAX) throw new AppError(422, 'VALIDATION_FAILED', `Group name must be 1 to ${GROUP_NAME_MAX} characters`);
    set.groupName = n;
  }
  if (patch.avatarUrl !== undefined) {
    if (patch.avatarUrl !== null && !patch.avatarUrl.startsWith(`${config.media.baseUrl}/`)) {
      throw new AppError(422, 'INVALID_MEDIA', 'Avatar must be uploaded through the media service');
    }
    set.groupAvatarUrl = patch.avatarUrl;
  }
  if (Object.keys(set).length === 0) return;
  await Conversation.updateOne({ _id: conv._id }, { $set: set });
  const names = await displayNames([adminId]);
  if (set.groupName) await createSystemMessage(conv._id, adminId, `${names.get(String(adminId))} renamed the group to "${set.groupName}"`);
  emitToConversation(String(conv._id), 'CONVERSATION_UPDATED', { conversationId: String(conv._id), change: 'RENAMED', ...set });
}

export async function addMembers(conversationId: IdLike, adminId: IdLike, userIds: IdLike[]) {
  const conv = await requireGroupAdmin(conversationId, adminId);
  const incoming = [...new Set(userIds.map(String))];
  const newIds = incoming.filter((id) => !conv.participantIds.some((p) => sameId(p, id)));
  if (newIds.length === 0) return { added: [] as string[] };
  await assertCanBeAdded(adminId, newIds);

  const now = new Date();
  const startPointer = conv.lastMessage?.messageId ?? null; // new members start with nothing unread
  const res = await Conversation.updateOne(
    {
      _id: conv._id,
      isGroup: true,
      adminIds: adminId,
      participantIds: { $nin: newIds }, // closes the race where two admins add the same person
      memberCount: { $lte: MAX_GROUP_MEMBERS - newIds.length }, // atomic cap: simultaneous adds cannot pass 100
    },
    {
      $push: { participants: { $each: newIds.map((id) => ({ userId: id, joinedAt: now, lastReadMessageId: startPointer })) } },
      $addToSet: { participantIds: { $each: newIds } },
      $inc: { memberCount: newIds.length },
    },
  );
  if (res.modifiedCount !== 1) {
    const fresh = await Conversation.findById(conv._id).select('memberCount participantIds adminIds').lean();
    if (!fresh || !fresh.adminIds.some((a) => sameId(a, adminId))) throw new AppError(403, 'NOT_GROUP_ADMIN', 'Only group admins can do this');
    if (fresh.participantIds.some((p) => newIds.includes(String(p)))) throw new AppError(409, 'ALREADY_MEMBER', 'Someone is already in this group');
    throw new AppError(409, 'GROUP_FULL', `Groups are limited to ${MAX_GROUP_MEMBERS} members`);
  }
  const id = String(conv._id);
  for (const uid of newIds) joinUserToConversation(uid, id);
  const names = await displayNames([adminId, ...newIds]);
  await createSystemMessage(id, adminId, `${names.get(String(adminId))} added ${newIds.map((u) => names.get(u)).join(', ')}`);
  emitToConversation(id, 'CONVERSATION_UPDATED', { conversationId: id, change: 'MEMBER_ADDED', userIds: newIds });
  return { added: newIds };
}

/** An admin removes anyone; any member can remove themselves (leave). */
export async function removeMember(conversationId: IdLike, actorId: IdLike, targetId: IdLike) {
  const conv = await getConversationFor(actorId, conversationId);
  if (!conv.isGroup) throw new AppError(422, 'NOT_A_GROUP', 'This is not a group chat');
  const leaving = sameId(actorId, targetId);
  if (!leaving && !conv.adminIds.some((a) => sameId(a, actorId))) {
    throw new AppError(403, 'NOT_GROUP_ADMIN', 'Only group admins can remove members');
  }
  if (!conv.participantIds.some((p) => sameId(p, targetId))) throw notFound('Member');

  const res = await Conversation.updateOne(
    {
      _id: conv._id,
      participantIds: targetId,
      // Allowed when the target is not an admin, another admin remains, or they are the last person in the group.
      $or: [{ adminIds: { $ne: targetId } }, { 'adminIds.1': { $exists: true } }, { memberCount: 1 }],
    },
    {
      $pull: { participants: { userId: targetId }, participantIds: targetId, adminIds: targetId },
      $inc: { memberCount: -1 },
    },
  );
  if (res.modifiedCount !== 1) {
    throw new AppError(409, 'LAST_ADMIN', 'Make someone else an admin before leaving');
  }
  const id = String(conv._id);
  removeUserFromConversation(String(targetId), id);
  const names = await displayNames([actorId, targetId]);
  await createSystemMessage(
    id,
    actorId,
    leaving ? `${names.get(String(targetId))} left` : `${names.get(String(actorId))} removed ${names.get(String(targetId))}`,
  );
  const payload = { conversationId: id, change: 'MEMBER_REMOVED', userIds: [String(targetId)] };
  emitToConversation(id, 'CONVERSATION_UPDATED', payload);
  emitToUser(String(targetId), 'CONVERSATION_UPDATED', payload); // the removed member is out of the room already
}

export async function setAdmin(conversationId: IdLike, actorId: IdLike, targetId: IdLike, promote: boolean) {
  const conv = await requireGroupAdmin(conversationId, actorId);
  if (!conv.participantIds.some((p) => sameId(p, targetId))) throw notFound('Member');
  const res = promote
    ? await Conversation.updateOne({ _id: conv._id }, { $addToSet: { adminIds: targetId } })
    : await Conversation.updateOne(
        { _id: conv._id, adminIds: targetId, 'adminIds.1': { $exists: true } }, // a group always keeps one admin
        { $pull: { adminIds: targetId } },
      );
  if (!promote && res.modifiedCount !== 1) throw new AppError(409, 'LAST_ADMIN', 'A group must keep at least one admin');
  const names = await displayNames([targetId]);
  const id = String(conv._id);
  await createSystemMessage(id, actorId, `${names.get(String(targetId))} ${promote ? 'is now an admin' : 'is no longer an admin'}`);
  emitToConversation(id, 'CONVERSATION_UPDATED', { conversationId: id, change: 'ADMIN_CHANGED', userId: String(targetId), isAdmin: promote });
}

/**
 * Called after a user is suspended or deactivated. Any group where they were the only admin gets the
 * member who joined earliest (and is still ACTIVE) as admin, so the group does not become unmanageable.
 */
export async function promoteReplacementAdmins(userId: IdLike): Promise<void> {
  const groups = await Conversation.find({ isGroup: true, adminIds: [toObjectId(userId)] }).lean();
  for (const g of groups) {
    const others = g.participants
      .filter((p) => !sameId(p.userId, userId))
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    if (others.length === 0) continue;
    const active = await User.find({ _id: { $in: others.map((p) => p.userId) }, status: 'ACTIVE' }).select('_id').lean();
    const activeIds = new Set(active.map((u) => String(u._id)));
    const pick = others.find((p) => activeIds.has(String(p.userId)));
    if (!pick) continue;
    const res = await Conversation.updateOne({ _id: g._id, adminIds: [toObjectId(userId)] }, { $addToSet: { adminIds: pick.userId } });
    if (res.modifiedCount !== 1) continue;
    const names = await displayNames([pick.userId]);
    await createSystemMessage(g._id, pick.userId, `${names.get(String(pick.userId))} is now an admin`);
    emitToConversation(String(g._id), 'CONVERSATION_UPDATED', {
      conversationId: String(g._id),
      change: 'ADMIN_CHANGED',
      userId: String(pick.userId),
      isAdmin: true,
    });
  }
}

// ---------------------------------------------------------------- blocks

export async function blockUser(meId: IdLike, targetId: IdLike): Promise<void> {
  if (sameId(meId, targetId)) throw new AppError(422, 'VALIDATION_FAILED', 'You cannot block yourself');
  if (!(await User.exists({ _id: targetId }))) throw notFound('User');
  await UserBlock.updateOne({ blockerId: meId, blockedId: targetId }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
}

export async function unblockUser(meId: IdLike, targetId: IdLike): Promise<void> {
  await UserBlock.deleteOne({ blockerId: meId, blockedId: targetId });
}
