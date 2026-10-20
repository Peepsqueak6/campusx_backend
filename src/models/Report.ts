import { Schema, model } from 'mongoose';
import { REPORT_DEDUP_SECONDS, REPORT_REASONS } from '../constants.js';

export const TARGET_TYPES = ['POST', 'USER', 'MESSAGE'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

const reportSchema = new Schema({
  reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  targetUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // owner of the reported content
  targetType: { type: String, enum: TARGET_TYPES, required: true },
  targetPostId: { type: Schema.Types.ObjectId, default: null },
  targetMessageId: { type: Schema.Types.ObjectId, default: null },
  reason: { type: String, enum: REPORT_REASONS, required: true },
  details: { type: String, maxlength: 300, default: null },
  tenantDomain: { type: String, required: true }, // the target's campus
  counted: { type: Boolean, required: true }, // false when inside the 30-day dedup window
  createdAt: { type: Date, default: Date.now },
});
reportSchema.index({ targetUserId: 1, createdAt: -1 });
reportSchema.index({ reporterId: 1, createdAt: -1 });

export const Report = model('Report', reportSchema);

// One row per (reporter, target account). Its unique index plus a 30-day TTL implement
// "one counted report per reporter per target per 30 days" without Redis.
const reportLockSchema = new Schema({
  reporterId: { type: Schema.Types.ObjectId, required: true },
  targetUserId: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now },
});
reportLockSchema.index({ reporterId: 1, targetUserId: 1 }, { unique: true });
reportLockSchema.index({ createdAt: 1 }, { expireAfterSeconds: REPORT_DEDUP_SECONDS });

export const ReportLock = model('ReportLock', reportLockSchema, 'report_locks');
