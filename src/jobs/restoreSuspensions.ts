import { Queue, Worker } from 'bullmq';
import { newRedis } from '../redis.js';
import { restoreExpiredSuspensions } from '../services/enforcement.js';

const QUEUE = 'maintenance';
const JOB = 'restore-expired-suspensions';

/**
 * Runs the auto-restore every minute as a BullMQ repeatable job. The job is idempotent and safe if two
 * workers pick it up, because each user is restored with a conditional update.
 */
export async function startMaintenanceJobs() {
  const queue = new Queue(QUEUE, { connection: newRedis({ maxRetriesPerRequest: null }) });
  await queue.upsertJobScheduler(JOB, { every: 60_000 }, { name: JOB });

  const worker = new Worker(
    QUEUE,
    async (job) => {
      if (job.name === JOB) {
        const restored = await restoreExpiredSuspensions();
        if (restored > 0) console.log(`restored ${restored} suspended account(s)`);
      }
    },
    { connection: newRedis({ maxRetriesPerRequest: null }) },
  );
  worker.on('failed', (job, err) => console.error(`job ${job?.name} failed`, err));

  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
