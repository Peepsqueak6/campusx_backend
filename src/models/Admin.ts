import { Schema, model } from 'mongoose';
import { AUDIT_ACTIONS } from '../constants.js';

// Blocks re-registration after Tier 2 or an admin ban. Only a SHA-256 of the email is stored.
const bannedEmailSchema = new Schema({
  emailHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  tenantDomain: { type: String, required: true },
  reason: { type: String, enum: ['TIER2_DEACTIVATION', 'ADMIN_BAN'], required: true },
  bannedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  bannedAt: { type: Date, default: Date.now },
});
export const BannedEmail = model('BannedEmail', bannedEmailSchema, 'banned_emails');

// Append-only. The application never updates or deletes these documents.
const auditSchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null = the system
  action: { type: String, enum: AUDIT_ACTIONS, required: true },
  targetUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  targetId: { type: Schema.Types.ObjectId, default: null },
  tenantDomain: { type: String, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});
auditSchema.index({ targetUserId: 1, createdAt: -1 });
auditSchema.index({ tenantDomain: 1, createdAt: -1 });
export const AdminAuditLog = model('AdminAuditLog', auditSchema, 'admin_audit_log');

// Profanity list, editable by moderators without a deploy.
const bannedTermSchema = new Schema({
  term: { type: String, required: true, maxlength: 100 },
  matchType: { type: String, enum: ['WORD', 'REGEX'], required: true },
  tenantDomain: { type: String, default: null }, // null = every campus
  active: { type: Boolean, default: true },
  addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});
bannedTermSchema.index({ active: 1, tenantDomain: 1 });
export const BannedTerm = model('BannedTerm', bannedTermSchema, 'banned_terms');
