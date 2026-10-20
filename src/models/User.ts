// STAND-IN for Module A's user model. It holds the fields Modules D and E need.
// Merge these fields into the real schema when Module A lands (see spec: "What you need from Module A").
import { Schema, model, Types, type InferSchemaType } from 'mongoose';
import { BADGE_TYPES, ROLES, USER_STATUSES } from '../constants.js';

const badgeSchema = new Schema(
  {
    type: { type: String, enum: BADGE_TYPES, default: 'NONE' },
    issuedAt: Date,
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  handle: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  bio: { type: String, maxlength: 160 },
  avatarUrl: String,
  bannerUrl: String,
  tenantDomain: { type: String, required: true, index: true },
  badge: { type: badgeSchema, default: () => ({}) },
  followersCount: { type: Number, default: 0 },
  followingCount: { type: Number, default: 0 },

  // Module E fields
  role: { type: String, enum: ROLES, default: 'USER' },
  status: { type: String, enum: USER_STATUSES, default: 'ACTIVE' },
  suspendedUntil: { type: Date, default: null },
  deactivatedAt: { type: Date, default: null },
  reportCount: { type: Number, default: 0 },
  flaggedForAudit: { type: Boolean, default: false },
  tokensInvalidBefore: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
});

userSchema.index({ status: 1, suspendedUntil: 1 }); // auto-restore job
userSchema.index({ flaggedForAudit: 1, tenantDomain: 1 }); // admin priority list

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model('User', userSchema);
