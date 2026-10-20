// Limits and thresholds from the Modules D & E spec. Keep numbers here, never inline.

export const ROLES = ['USER', 'MODERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = {
  USER: 0,
  MODERATOR: 1,
  TENANT_ADMIN: 2,
  SUPER_ADMIN: 3,
};

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const BADGE_TYPES = ['NONE', 'GOLD', 'BLUE', 'GREEN'] as const;
export type BadgeType = (typeof BADGE_TYPES)[number];

// Module D
export const MAX_GROUP_MEMBERS = 100;
export const GROUP_NAME_MAX = 50;
export const MESSAGE_MAX_CHARS = 2000;
export const MESSAGE_RATE = { limit: 20, windowSec: 10 };
export const DECLINE_COOLDOWN_DAYS = 30;
export const REQUEST_MESSAGE_LIMIT = 1; // messages a requester may send before the recipient accepts
export const TYPING_EXPIRY_MS = 5000;
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4'];

// Module E
export const TIER1_THRESHOLD = 10;
export const TIER2_THRESHOLD = 20;
export const SUSPENSION_DAYS = 7;
export const REPORT_DEDUP_SECONDS = 30 * 24 * 60 * 60;
export const REPORT_RATE = { limit: 10, windowSec: 60 * 60 };
export const MESSAGE_CONTEXT_WINDOW = 5; // messages shown before and after a reported message

export const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'HATE_SPEECH', 'NSFW', 'IMPERSONATION', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const AUDIT_ACTIONS = [
  'BADGE_ISSUED',
  'BADGE_REVOKED',
  'POST_APPROVED',
  'POST_DELETED',
  'USER_SUSPENDED',
  'USER_RESTORED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'ROLE_CHANGED',
  'EMAIL_UNBANNED',
  'MESSAGE_CONTEXT_VIEWED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const ENFORCEMENT_CHANNEL = 'user-enforcement';
