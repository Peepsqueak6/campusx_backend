import type { ClientSession } from 'mongoose';
import { isDuplicateKey } from '../db.js';
import { ModerationQueueItem } from '../models/index.js';
import type { TargetType } from '../models/Report.js';
import type { IdLike } from '../util/helpers.js';

export interface AddToQueueInput {
  targetType: TargetType;
  targetPostId?: IdLike | null;
  targetMessageId?: IdLike | null;
  targetUserId: IdLike;
  tenantDomain: string;
  source: 'PROFANITY_FILTER' | 'USER_REPORT' | 'AUTO_ENFORCEMENT';
  flaggedBy?: IdLike | null;
  reportId?: IdLike;
  matchedTerms?: string[];
}

/**
 * Adds to the one open queue item for this target, creating it if none is open.
 * The partial unique index guarantees a single PENDING item per target, so two requests that race to
 * create it can collide. The loser retries and then updates the winner's document.
 */
export async function addToQueue(input: AddToQueueInput, session?: ClientSession) {
  const filter: Record<string, unknown> = {
    targetType: input.targetType,
    targetPostId: input.targetPostId ?? null,
    targetMessageId: input.targetMessageId ?? null,
    targetUserId: input.targetUserId,
    status: 'PENDING',
  };
  const update: Record<string, unknown> = {
    $setOnInsert: {
      tenantDomain: input.tenantDomain,
      source: input.source,
      flaggedBy: input.flaggedBy ?? null,
      createdAt: new Date(),
    },
  };
  if (input.reportId) {
    update.$addToSet = { reportIds: input.reportId };
    update.$inc = { reportCount: 1 };
  }
  if (input.matchedTerms?.length) {
    update.$addToSet = { ...(update.$addToSet as object), matchedTerms: { $each: input.matchedTerms } };
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await ModerationQueueItem.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        session,
      });
    } catch (err) {
      if (isDuplicateKey(err) && attempt < 2) continue;
      throw err;
    }
  }
}
