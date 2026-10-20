import { REPORT_RATE, type ReportReason } from '../constants.js';
import { isDuplicateKey } from '../db.js';
import { AppError, notFound, notParticipant } from '../errors.js';
import { Conversation, Message, Post, Report, ReportLock, User } from '../models/index.js';
import type { TargetType } from '../models/Report.js';
import { rateLimit } from '../redis.js';
import { sameId, type IdLike } from '../util/helpers.js';
import { decideEnforcement, deactivateUser, isExempt, suspendUser } from './enforcement.js';
import { addToQueue } from './moderationQueue.js';

export interface SubmitReportInput {
  reporterId: IdLike;
  targetType: TargetType;
  targetPostId?: IdLike;
  targetUserId?: IdLike;
  targetMessageId?: IdLike;
  reason: ReportReason;
  details?: string;
}

/**
 * Records a report and applies the Tier 1 / Tier 2 policy.
 *
 * The caller always gets the same response whether or not the report counted, so people cannot probe the
 * 30-day dedup window. A report inside the window is still stored and still reaches the moderator queue.
 */
export async function submitReport(input: SubmitReportInput): Promise<{ reportId: string }> {
  const allowed = await rateLimit(`report:${input.reporterId}`, REPORT_RATE.limit, REPORT_RATE.windowSec);
  if (!allowed) throw new AppError(429, 'RATE_LIMITED', 'You are reporting too fast. Try again later');

  const target = await resolveTarget(input);
  if (sameId(target.userId, input.reporterId)) {
    throw new AppError(422, 'CANNOT_REPORT_SELF', 'You cannot report yourself');
  }

  // The lock insert is the atomic "first counted report in 30 days" check.
  let counted = true;
  try {
    await ReportLock.create({ reporterId: input.reporterId, targetUserId: target.userId });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    counted = false;
  }

  const report = await Report.create({
    reporterId: input.reporterId,
    targetUserId: target.userId,
    targetType: input.targetType,
    targetPostId: input.targetType === 'POST' ? input.targetPostId : null,
    targetMessageId: input.targetType === 'MESSAGE' ? input.targetMessageId : null,
    reason: input.reason,
    details: input.details ?? null,
    tenantDomain: target.tenantDomain,
    counted,
  });

  // Every report reaches the moderators, counted or not. Reports on the same target share one open queue item.
  await addToQueue({
    targetType: input.targetType,
    targetPostId: input.targetType === 'POST' ? input.targetPostId : null,
    targetMessageId: input.targetType === 'MESSAGE' ? input.targetMessageId : null,
    targetUserId: target.userId,
    tenantDomain: target.tenantDomain,
    source: 'USER_REPORT',
    flaggedBy: input.reporterId,
    reportId: report._id,
  });

  if (counted) await applyThresholds(target.userId);
  return { reportId: String(report._id) };
}

/**
 * One atomic increment that returns the new count. Only one concurrent request can ever see exactly 10,
 * so Tier 1 fires once even when reports arrive together. The suspend/deactivate calls are conditional too.
 */
async function applyThresholds(targetUserId: IdLike): Promise<void> {
  const user = await User.findOneAndUpdate({ _id: targetUserId }, { $inc: { reportCount: 1 } }, { new: true })
    .select('reportCount status role badge tenantDomain')
    .lean();
  if (!user) return;

  const decision = decideEnforcement({
    reportCount: user.reportCount,
    status: user.status as 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED',
    exempt: isExempt(user),
  });

  switch (decision) {
    case 'SUSPEND':
      await suspendUser({ userId: user._id, actorId: null, reason: 'AUTO_REPORT_THRESHOLD', reportCount: user.reportCount });
      break;
    case 'DEACTIVATE':
      await deactivateUser({ userId: user._id, actorId: null, reason: 'AUTO_REPORT_THRESHOLD', reportCount: user.reportCount });
      break;
    case 'QUEUE':
      await addToQueue({
        targetType: 'USER',
        targetUserId: user._id,
        tenantDomain: user.tenantDomain,
        source: 'AUTO_ENFORCEMENT',
      });
      break;
    case 'NONE':
      break;
  }
}

async function resolveTarget(input: SubmitReportInput): Promise<{ userId: IdLike; tenantDomain: string }> {
  if (input.targetType === 'POST') {
    if (!input.targetPostId) throw new AppError(422, 'VALIDATION_FAILED', 'targetPostId is required');
    const post = await Post.findById(input.targetPostId).select('authorId tenantDomain').lean();
    if (!post) throw notFound('Post');
    return { userId: post.authorId, tenantDomain: post.tenantDomain };
  }

  if (input.targetType === 'USER') {
    if (!input.targetUserId) throw new AppError(422, 'VALIDATION_FAILED', 'targetUserId is required');
    const user = await User.findById(input.targetUserId).select('tenantDomain').lean();
    if (!user) throw notFound('User');
    return { userId: user._id, tenantDomain: user.tenantDomain };
  }

  if (!input.targetMessageId) throw new AppError(422, 'VALIDATION_FAILED', 'targetMessageId is required');
  const msg = await Message.findById(input.targetMessageId).select('conversationId senderId type').lean();
  if (!msg) throw notFound('Message');
  // Only people in the conversation can report one of its messages.
  const conv = await Conversation.findById(msg.conversationId).select('participantIds').lean();
  if (!conv || !conv.participantIds.some((p) => sameId(p, input.reporterId))) throw notParticipant();
  if (msg.type === 'SYSTEM') throw new AppError(422, 'NOT_REPORTABLE', 'System messages cannot be reported');
  const sender = await User.findById(msg.senderId).select('tenantDomain').lean();
  if (!sender) throw notFound('User');
  return { userId: sender._id, tenantDomain: sender.tenantDomain };
}
