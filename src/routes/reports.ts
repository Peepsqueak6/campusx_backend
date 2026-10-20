import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me } from '../auth/middleware.js';
import { REPORT_REASONS } from '../constants.js';
import { submitReport } from '../services/reports.js';
import { objectIdSchema } from '../util/helpers.js';

export const reportsRouter = Router();

const body = z.object({
  targetType: z.enum(['POST', 'USER', 'MESSAGE']),
  targetPostId: objectIdSchema.optional(),
  targetUserId: objectIdSchema.optional(),
  targetMessageId: objectIdSchema.optional(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(300).optional(),
});

// POST /api/v1/reports
reportsRouter.post('/', authenticate, async (req, res) => {
  const input = body.parse(req.body);
  const { reportId } = await submitReport({ reporterId: me(req).id, ...input });
  // Identical response whether or not the report counted toward the thresholds.
  res.status(201).json({ reportId });
});
