// Dev only: creates a few users and prints a token for each, so you can try the API by hand.
// Safe to run again: it resets the test users to ACTIVE with a clean report count.
import 'dotenv/config';
import { signToken } from '../auth/jwt.js';
import { connectDb, disconnectDb } from '../db.js';
import { Follow, Post, User, ensureIndexes } from '../models/index.js';
import { closeRedis, getRedis } from '../redis.js';

const TENANT = 'unilag.edu.ng';
const people = [
  { key: 'ada', displayName: 'Ada Student', role: 'USER' },
  { key: 'tunde', displayName: 'Tunde Student', role: 'USER' },
  { key: 'chidi', displayName: 'Chidi Student', role: 'USER' }, // does not follow anyone: use for message requests
  { key: 'mod', displayName: 'Moderator', role: 'MODERATOR' },
  { key: 'tadmin', displayName: 'Tenant Admin', role: 'TENANT_ADMIN' },
  { key: 'sadmin', displayName: 'Super Admin', role: 'SUPER_ADMIN' },
] as const;

async function main() {
  await connectDb();
  await ensureIndexes();

  const users: Record<string, { id: string; token: string }> = {};
  for (const p of people) {
    const user = await User.findOneAndUpdate(
      { email: `${p.key}@student.${TENANT}` },
      {
        $setOnInsert: { handle: `@${p.key}`, displayName: p.displayName, tenantDomain: TENANT },
        $set: { role: p.role, status: 'ACTIVE', suspendedUntil: null, deactivatedAt: null, reportCount: 0, tokensInvalidBefore: null, flaggedForAudit: false },
      },
      { upsert: true, new: true },
    );
    await getRedis().del(`tib:${user!._id}`);
    users[p.key] = { id: String(user!._id), token: signToken(String(user!._id), 24 * 60 * 60) };
  }

  // Ada and Tunde follow each other, so their chat starts ACTIVE. Chidi follows nobody.
  for (const [a, b] of [['ada', 'tunde'], ['tunde', 'ada']] as const) {
    await Follow.updateOne({ followerId: users[a]!.id, followeeId: users[b]!.id }, { $setOnInsert: {} }, { upsert: true });
  }
  const post = await Post.findOneAndUpdate(
    { authorId: users.tunde!.id, content: 'Anyone have the CSC301 past questions?' },
    { $setOnInsert: { tenantDomain: TENANT } },
    { upsert: true, new: true },
  );

  console.log('\nSeeded. Tokens last 24 hours. Copy these into your shell:\n');
  for (const p of people) console.log(`export ${p.key.toUpperCase()}_ID=${users[p.key]!.id} ${p.key.toUpperCase()}=${users[p.key]!.token}`);
  console.log(`\nexport POST_ID=${post!._id}\n`);

  await disconnectDb();
  await closeRedis();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
