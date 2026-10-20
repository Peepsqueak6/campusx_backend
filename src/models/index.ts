import { User } from './User.js';
import { Follow } from './Follow.js';
import { Post } from './Post.js';
import { Conversation } from './Conversation.js';
import { Message } from './Message.js';
import { UserBlock } from './UserBlock.js';
import { Report, ReportLock } from './Report.js';
import { ModerationQueueItem } from './ModerationQueueItem.js';
import { BannedEmail, AdminAuditLog, BannedTerm } from './Admin.js';

export {
  User,
  Follow,
  Post,
  Conversation,
  Message,
  UserBlock,
  Report,
  ReportLock,
  ModerationQueueItem,
  BannedEmail,
  AdminAuditLog,
  BannedTerm,
};
export { isMutualFollow } from './Follow.js';

const all = [
  User,
  Follow,
  Post,
  Conversation,
  Message,
  UserBlock,
  Report,
  ReportLock,
  ModerationQueueItem,
  BannedEmail,
  AdminAuditLog,
  BannedTerm,
];

/** Builds every index (unique, partial, TTL). Call once at startup and in tests. */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(all.map((m) => m.init()));
}
