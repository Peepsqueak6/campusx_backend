// STAND-IN for Module B's post model. Module B must add `moderationStatus` and `removedReason`,
// and every feed, thread and search query must filter on moderationStatus = 'PUBLISHED'.
import { Schema, model } from 'mongoose';

export const MODERATION_STATUSES = ['PUBLISHED', 'PENDING_REVIEW', 'REMOVED'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

const postSchema = new Schema({
  authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  content: { type: String, required: true, maxlength: 280 },
  tenantDomain: { type: String, required: true, index: true },
  moderationStatus: { type: String, enum: MODERATION_STATUSES, default: 'PUBLISHED', index: true },
  removedReason: { type: String, enum: ['MODERATION', 'ACCOUNT_DEACTIVATED', null], default: null },
  createdAt: { type: Date, default: Date.now, index: true },
});

export const Post = model('Post', postSchema);
