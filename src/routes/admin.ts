import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requireRole } from '../auth/middleware.js';
import { restoreUser } from '../services/enforcement.js';
import * as admin from '../services/adminUsers.js';
import * as moderation from '../services/moderation.js';
import { objectIdSchema, parseObjectId } from '../util/helpers.js';

export const adminRouter = Router();

// Everything under /admin needs at least a moderator. Stricter routes add their own requireRole.
adminRouter.use(authenticate, requireRole('MODERATOR'));

const idParam = (v: string | string[] | undefined) => parseObjectId(String(v));
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const note = z.object({ note: z.string().trim().max(500).optional() });

// ---------------------------------------------------------------- moderation queue

adminRouter.get('/moderation', async (req, res) => {
  const q = req.query;
  res.json(
    await moderation.listQueue(me(req), {
      status: str(q.status),
      source: str(q.source),
      tenantDomain: str(q.tenantDomain),
      cursor: str(q.cursor),
      limit: q.limit,
    }),
  );
});

adminRouter.get('/moderation/:id', async (req, res) => {
  res.json(await moderation.getQueueItem(me(req), idParam(req.params.id)));
});

adminRouter.post('/moderation/:id/approve', async (req, res) => {
  await moderation.approveItem(me(req), idParam(req.params.id), note.parse(req.body ?? {}).note);
  res.status(204).end();
});

// PRD endpoint. Hides the post from feeds and the cache (the document is kept as evidence).
adminRouter.delete('/moderation/:id', async (req, res) => {
  await moderation.removeItem(me(req), idParam(req.params.id), note.parse(req.body ?? {}).note);
  res.status(204).end();
});

// ---------------------------------------------------------------- accounts

adminRouter.get('/users', async (req, res) => {
  const q = req.query;
  res.json(
    await admin.listUsers(me(req), {
      status: str(q.status),
      flagged: str(q.flagged),
      q: str(q.q),
      tenantDomain: str(q.tenantDomain),
      cursor: str(q.cursor),
      limit: q.limit,
    }),
  );
});

adminRouter.get('/users/:id', async (req, res) => {
  res.json(await admin.getUser(me(req), idParam(req.params.id)));
});

adminRouter.post('/users/:id/suspend', requireRole('TENANT_ADMIN'), async (req, res) => {
  const { days, reason } = z
    .object({ days: z.number().int().min(1).max(30), reason: z.string().trim().min(1).max(500) })
    .parse(req.body);
  await admin.suspendManually(me(req), idParam(req.params.id), days, reason);
  res.status(204).end();
});

adminRouter.post('/users/:id/restore', requireRole('TENANT_ADMIN'), async (req, res) => {
  const actor = me(req);
  const id = idParam(req.params.id);
  await admin.assertCanRestore(actor, id);
  await restoreUser(id, actor); // reversing a deactivation is checked inside: SUPER_ADMIN only
  res.status(204).end();
});

adminRouter.post('/users/:id/deactivate', requireRole('TENANT_ADMIN'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
  await admin.deactivateManually(me(req), idParam(req.params.id), reason);
  res.status(204).end();
});

adminRouter.patch('/users/:id/role', requireRole('SUPER_ADMIN'), async (req, res) => {
  const { role } = z.object({ role: z.enum(['USER', 'MODERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN']) }).parse(req.body);
  await admin.setRole(me(req), idParam(req.params.id), role);
  res.status(204).end();
});

// ---------------------------------------------------------------- badges

// PRD endpoint. Only SUPER_ADMIN may issue GOLD (checked in the service).
adminRouter.post('/badges/issue', requireRole('TENANT_ADMIN'), async (req, res) => {
  const { userId, type } = z.object({ userId: objectIdSchema, type: z.enum(['GOLD', 'BLUE', 'GREEN']) }).parse(req.body);
  await admin.issueBadge(me(req), userId, type);
  res.status(204).end();
});

adminRouter.delete('/badges/:userId', requireRole('TENANT_ADMIN'), async (req, res) => {
  await admin.revokeBadge(me(req), idParam(req.params.userId));
  res.status(204).end();
});

// ---------------------------------------------------------------- profanity list

adminRouter.get('/banned-terms', async (req, res) => {
  res.json({ items: await admin.listTerms(me(req)) });
});

adminRouter.post('/banned-terms', async (req, res) => {
  const input = z
    .object({
      term: z.string().trim().min(1).max(100),
      matchType: z.enum(['WORD', 'REGEX']),
      global: z.boolean().optional(),
    })
    .parse(req.body);
  res.status(201).json(await admin.addTerm(me(req), input));
});

adminRouter.delete('/banned-terms/:id', async (req, res) => {
  await admin.deactivateTerm(me(req), idParam(req.params.id));
  res.status(204).end();
});

// ---------------------------------------------------------------- audit log

adminRouter.get('/audit-log', requireRole('TENANT_ADMIN'), async (req, res) => {
  const q = req.query;
  res.json(
    await admin.listAudit(me(req), {
      targetUserId: str(q.targetUserId),
      action: str(q.action),
      tenantDomain: str(q.tenantDomain),
      cursor: str(q.cursor),
      limit: q.limit,
    }),
  );
});
