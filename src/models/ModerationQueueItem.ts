import { Schema, model, Types, type InferSchemaType } from 'mongoose';
import { TARGET_TYPES } from './Report.js';

export const QUEUE_SOURCES = ['PROFANITY_FILTER', 'USER_REPORT', 'AUTO_ENFORCEMENT'] as const;
export const QUEUE_STATUSES = ['PENDING', 'APPROVED', 'DELETED'] as const;
export const QUEUE_RESOLUTIONS = ['CONTENT_KEPT', 'CONTENT_REMOVED', 'USER_SUSPENDED', 'USER_DEACTIVATED'] as const;

const queueSchema = new Schema({
  targetType: { type: String, enum: TARGET_TYPES, required: true },
  targetPostId: { type: Schema.Types.ObjectId, default: null },
  targetMessageId: { type: Schema.Types.ObjectId, default: null },
  targetUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  tenantDomain: { type: String, required: true },
  source: { type: String, enum: QUEUE_SOURCES, required: true },
  flaggedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reportIds: [{ type: Schema.Types.ObjectId, ref: 'Report' }],
  reportCount: { type: Number, default: 0 },
  matchedTerms: [String],
  status: { type: String, enum: QUEUE_STATUSES, default: 'PENDING' },
  resolution: { type: String, enum: [...QUEUE_RESOLUTIONS, null], default: null },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

queueSchema.index({ tenantDomain: 1, status: 1, createdAt: 1 });
// One open item per target, so ten reports on one post make one queue entry.
queueSchema.index(
  { targetType: 1, targetPostId: 1, targetMessageId: 1, targetUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } },
);

export type QueueItemDoc = InferSchemaType<typeof queueSchema> & { _id: Types.ObjectId };
export const ModerationQueueItem = model('ModerationQueueItem', queueSchema, 'moderation_queue');
