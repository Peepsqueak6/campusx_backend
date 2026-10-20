import express from 'express';
import { errorHandler } from './errors.js';
import { adminRouter } from './routes/admin.js';
import { blocksRouter, chatsRouter } from './routes/chats.js';
import { reportsRouter } from './routes/reports.js';

/**
 * Builds the REST app for Modules D and E. When Modules A and B land, mount these routers in the shared app
 * instead of this one (keep the same /api/v1 prefix).
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/v1/chats', chatsRouter);
  app.use('/api/v1/users', blocksRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
