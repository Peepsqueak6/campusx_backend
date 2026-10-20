import 'dotenv/config'; // must stay first: loads .env before config.ts reads process.env
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { startMaintenanceJobs } from './jobs/restoreSuspensions.js';
import { ensureIndexes } from './models/index.js';
import { attachSocketServer } from './realtime/socket.js';
import { closeRedis } from './redis.js';

async function main() {
  await connectDb();
  await ensureIndexes();

  const httpServer = createServer(createApp());
  const sockets = await attachSocketServer(httpServer);
  // Set RUN_JOBS=false on instances that should not run the scheduled jobs.
  const jobs = process.env.RUN_JOBS === 'false' ? null : await startMaintenanceJobs();

  httpServer.listen(config.port, () => console.log(`Campus X (modules D and E) listening on :${config.port}`));

  const shutdown = async () => {
    httpServer.close();
    await sockets.close();
    await jobs?.close();
    await closeRedis();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
