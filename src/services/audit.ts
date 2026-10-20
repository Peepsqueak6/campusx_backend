import type { ClientSession } from 'mongoose';
import type { AuditAction } from '../constants.js';
import { AdminAuditLog } from '../models/index.js';
import type { IdLike } from '../util/helpers.js';

export interface AuditEntry {
  actorId: IdLike | null; // null = the system (automatic enforcement)
  action: AuditAction;
  targetUserId?: IdLike | null;
  targetId?: IdLike | null;
  tenantDomain: string;
  metadata?: Record<string, unknown>;
}

/** Appends one audit entry. Pass the session when the action also changes other documents. */
export async function writeAudit(entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AdminAuditLog.create(
    [
      {
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetUserId: entry.targetUserId ?? null,
        targetId: entry.targetId ?? null,
        tenantDomain: entry.tenantDomain,
        metadata: entry.metadata ?? {},
      },
    ],
    { session },
  );
}
