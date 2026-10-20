// Integration tests for Module E. They need MongoDB as a replica set (transactions) and Redis.
//   MONGO_TEST_URL="mongodb://127.0.0.1:27017/campusx_test?replicaSet=rs0" npm test
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/db.js';
import {
  AdminAuditLog,
  BannedEmail,
  BannedTerm,
  ModerationQueueItem,
  Post,
  Report,
  User,
  ensureIndexes,
} from '../src/models/index.js';
import { closeRedis, getTokensInvalidBefore } from '../src/redis.js';
import { checkContent, holdPostForReview, invalidateTermCache } from '../src/services/contentFilter.js';
import { restoreExpiredSuspensions, suspendUser } from '../src/services/enforcement.js';
import { submitReport } from '../src/services/reports.js';
import { emailHash } from '../src/util/helpers.js';
import { bearer, clearAll, id, makeUser, makeUsers } from './helpers.js';

const url = process.env.MONGO_TEST_URL;
const app = createApp();
const reportUser = (reporter: { _id: unknown }, target: { _id: unknown }) =>
  submitReport({ reporterId: id(reporter), targetType: 'USER', targetUserId: id(target), reason: 'SPAM' });

describe.skipIf(!url)('Module E', () => {
  beforeAll(async () => {
    await connectDb(url!);
    await ensureIndexes();
  });
  afterEach(clearAll);
  afterAll(async () => {
    await disconnectDb();
    await closeRedis();
  });

  describe('reports', () => {
    it('stores a repeat report inside 30 days but counts it once, with an identical response', async () => {
      const reporter = await makeUser();
      const target = await makeUser();
      const post = await Post.create({ authorId: target._id, content: 'hi', tenantDomain: 'test.edu' });
      const send = () =>
        request(app)
          .post('/api/v1/reports')
          .set('Authorization', bearer(reporter))
          .send({ targetType: 'POST', targetPostId: id(post), reason: 'SPAM' });

      const first = await send();
      const second = await send();
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(Object.keys(second.body)).toEqual(Object.keys(first.body));

      expect((await User.findById(target._id))!.reportCount).toBe(1);
      const reports = await Report.find({ targetUserId: target._id }).sort({ createdAt: 1 });
      expect(reports.map((r) => r.counted)).toEqual([true, false]);

      // both reports land on ONE open queue item
      const items = await ModerationQueueItem.find({ targetUserId: target._id, status: 'PENDING' });
      expect(items).toHaveLength(1);
      expect(items[0]!.reportCount).toBe(2);
    });

    it('rejects reporting yourself and unauthenticated reports', async () => {
      const me = await makeUser();
      const self = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', bearer(me))
        .send({ targetType: 'USER', targetUserId: id(me), reason: 'SPAM' });
      expect(self.status).toBe(422);
      expect(self.body.error.code).toBe('CANNOT_REPORT_SELF');

      const anon = await request(app).post('/api/v1/reports').send({});
      expect(anon.status).toBe(401);
    });
  });

  describe('enforcement policy', () => {
    it('suspends at the 10th counted report, does nothing for 11 to 19, and deactivates at the 20th', async () => {
      const target = await makeUser();
      await Post.create({ authorId: target._id, content: 'hello', tenantDomain: 'test.edu' });
      const reporters = await makeUsers(20);

      for (let i = 0; i < 9; i++) await reportUser(reporters[i]!, target);
      expect((await User.findById(target._id))!.status).toBe('ACTIVE');

      await reportUser(reporters[9]!, target);
      const suspended = (await User.findById(target._id))!;
      expect(suspended.status).toBe('SUSPENDED');
      expect(suspended.flaggedForAudit).toBe(true);
      expect(suspended.tokensInvalidBefore).not.toBeNull();
      expect(Math.abs(suspended.suspendedUntil!.getTime() - (Date.now() + 7 * 86_400_000))).toBeLessThan(60_000);
      expect(await getTokensInvalidBefore(id(target))).not.toBeNull();
      const suspendAudit = await AdminAuditLog.find({ targetUserId: target._id, action: 'USER_SUSPENDED' });
      expect(suspendAudit).toHaveLength(1);
      expect(suspendAudit[0]!.actorId).toBeNull();

      for (let i = 10; i < 19; i++) await reportUser(reporters[i]!, target);
      expect((await User.findById(target._id))!.status).toBe('SUSPENDED');

      await reportUser(reporters[19]!, target);
      const gone = (await User.findById(target._id))!;
      expect(gone.status).toBe('DEACTIVATED');
      expect(gone.reportCount).toBe(20);
      expect(await BannedEmail.countDocuments({ emailHash: emailHash(gone.email) })).toBe(1);
      expect((await Post.findOne({ authorId: target._id }))!.moderationStatus).toBe('REMOVED');
    });

    it('applies exactly one suspension when reports arrive together at the threshold', async () => {
      const target = await makeUser();
      const reporters = await makeUsers(12);
      for (let i = 0; i < 9; i++) await reportUser(reporters[i]!, target);

      await Promise.all(reporters.slice(9).map((r) => reportUser(r, target)));

      const after = (await User.findById(target._id))!;
      expect(after.reportCount).toBe(12);
      expect(after.status).toBe('SUSPENDED');
      expect(await AdminAuditLog.countDocuments({ targetUserId: target._id, action: 'USER_SUSPENDED' })).toBe(1);
    });

    it('restores a suspended account after 7 days and keeps the report count', async () => {
      const target = await makeUser();
      const reporters = await makeUsers(10);
      for (const r of reporters) await reportUser(r, target);
      expect((await User.findById(target._id))!.status).toBe('SUSPENDED');

      // not due yet
      expect(await restoreExpiredSuspensions(new Date())).toBe(0);

      const inEightDays = new Date(Date.now() + 8 * 86_400_000);
      expect(await restoreExpiredSuspensions(inEightDays)).toBe(1);
      const after = (await User.findById(target._id))!;
      expect(after.status).toBe('ACTIVE');
      expect(after.reportCount).toBe(10);
      expect(after.suspendedUntil).toBeNull();
      const restoreAudit = await AdminAuditLog.find({ targetUserId: target._id, action: 'USER_RESTORED' });
      expect(restoreAudit).toHaveLength(1);
      expect(restoreAudit[0]!.actorId).toBeNull();

      // running the job again changes nothing
      expect(await restoreExpiredSuspensions(inEightDays)).toBe(0);
    });

    it('does not auto-suspend Gold or staff accounts, and queues them for an admin', async () => {
      const gold = await makeUser({ badge: { type: 'GOLD' } });
      const reporters = await makeUsers(10);
      for (const r of reporters) await reportUser(r, gold);
      expect((await User.findById(gold._id))!.status).toBe('ACTIVE');
      expect(await ModerationQueueItem.countDocuments({ targetUserId: gold._id, status: 'PENDING' })).toBe(1);
    });

    it('rejects old tokens after suspension and accepts a fresh login after restore', async () => {
      const user = await makeUser();
      const oldToken = bearer(user);
      await suspendUser({ userId: user._id, actorId: null });

      const blocked = await request(app).get('/api/v1/chats').set('Authorization', oldToken);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(blocked.body.error.suspendedUntil).toBeTruthy();

      await restoreExpiredSuspensions(new Date(Date.now() + 8 * 86_400_000));
      const stale = await request(app).get('/api/v1/chats').set('Authorization', oldToken);
      expect(stale.status).toBe(401);
      expect(stale.body.error.code).toBe('TOKEN_REVOKED');

      const fresh = await request(app)
        .get('/api/v1/chats')
        .set('Authorization', bearer(user, Math.floor(Date.now() / 1000) + 5));
      expect(fresh.status).toBe(200);
    });
  });

  describe('moderation queue and admin routes', () => {
    it('keeps a campus queue private to that campus', async () => {
      const modA = await makeUser({ role: 'MODERATOR', tenantDomain: 'a.edu' });
      const modB = await makeUser({ role: 'MODERATOR', tenantDomain: 'b.edu' });
      const author = await makeUser({ tenantDomain: 'b.edu' });
      const reporter = await makeUser({ tenantDomain: 'b.edu' });
      const post = await Post.create({ authorId: author._id, content: 'x', tenantDomain: 'b.edu' });
      await submitReport({ reporterId: id(reporter), targetType: 'POST', targetPostId: id(post), reason: 'SPAM' });
      const item = (await ModerationQueueItem.findOne())!;

      const listA = await request(app).get('/api/v1/admin/moderation').set('Authorization', bearer(modA));
      expect(listA.body.items).toHaveLength(0);
      expect((await request(app).get(`/api/v1/admin/moderation/${id(item)}`).set('Authorization', bearer(modA))).status).toBe(404);
      expect((await request(app).post(`/api/v1/admin/moderation/${id(item)}/approve`).set('Authorization', bearer(modA))).status).toBe(404);

      const listB = await request(app).get('/api/v1/admin/moderation').set('Authorization', bearer(modB));
      expect(listB.body.items).toHaveLength(1);
    });

    it('holds a filtered post, publishes it on approve, and hides a reported post on delete', async () => {
      const mod = await makeUser({ role: 'MODERATOR' });
      const author = await makeUser();
      await BannedTerm.create({ term: 'badword', matchType: 'WORD', addedBy: mod._id, tenantDomain: null });
      invalidateTermCache();

      const check = await checkContent('this is a BADWORD post', 'test.edu');
      expect(check).toEqual({ ok: false, matchedTerms: ['badword'] });
      expect((await checkContent('a clean post', 'test.edu')).ok).toBe(true);

      const held = await Post.create({ authorId: author._id, content: 'badword', tenantDomain: 'test.edu' });
      await holdPostForReview({ postId: held._id, authorId: author._id, tenantDomain: 'test.edu', matchedTerms: check.matchedTerms });
      expect((await Post.findById(held._id))!.moderationStatus).toBe('PENDING_REVIEW');

      const item = (await ModerationQueueItem.findOne({ targetPostId: held._id }))!;
      expect(item.source).toBe('PROFANITY_FILTER');
      const approve = await request(app).post(`/api/v1/admin/moderation/${id(item)}/approve`).set('Authorization', bearer(mod)).send({});
      expect(approve.status).toBe(204);
      expect((await Post.findById(held._id))!.moderationStatus).toBe('PUBLISHED');
      const again = await request(app).post(`/api/v1/admin/moderation/${id(item)}/approve`).set('Authorization', bearer(mod)).send({});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('QUEUE_ITEM_RESOLVED');

      const reported = await Post.create({ authorId: author._id, content: 'nasty', tenantDomain: 'test.edu' });
      const reporter = await makeUser();
      await submitReport({ reporterId: id(reporter), targetType: 'POST', targetPostId: id(reported), reason: 'HARASSMENT' });
      const item2 = (await ModerationQueueItem.findOne({ targetPostId: reported._id }))!;
      const del = await request(app).delete(`/api/v1/admin/moderation/${id(item2)}`).set('Authorization', bearer(mod));
      expect(del.status).toBe(204);
      const gone = (await Post.findById(reported._id))!;
      expect(gone.moderationStatus).toBe('REMOVED');
      expect(gone.removedReason).toBe('MODERATION');
      expect((await ModerationQueueItem.findById(item2._id))!.status).toBe('DELETED');
    });

    it('limits who can issue badges and who can act on whom', async () => {
      const tenantAdmin = await makeUser({ role: 'TENANT_ADMIN' });
      const otherTenantAdmin = await makeUser({ role: 'TENANT_ADMIN' });
      const superAdmin = await makeUser({ role: 'SUPER_ADMIN' });
      const moderator = await makeUser({ role: 'MODERATOR' });
      const student = await makeUser();

      const gold = (who: { _id: unknown }) =>
        request(app).post('/api/v1/admin/badges/issue').set('Authorization', bearer(who)).send({ userId: id(student), type: 'GOLD' });
      expect((await gold(tenantAdmin)).status).toBe(403);
      expect((await request(app).post('/api/v1/admin/badges/issue').set('Authorization', bearer(tenantAdmin)).send({ userId: id(student), type: 'BLUE' })).status).toBe(204);
      expect((await User.findById(student._id))!.badge!.type).toBe('BLUE');
      expect((await gold(superAdmin)).status).toBe(204);
      expect((await User.findById(student._id))!.badge!.type).toBe('GOLD');
      expect(await AdminAuditLog.countDocuments({ action: 'BADGE_ISSUED' })).toBe(2);

      const suspend = (who: { _id: unknown }, target: { _id: unknown }) =>
        request(app).post(`/api/v1/admin/users/${id(target)}/suspend`).set('Authorization', bearer(who)).send({ days: 3, reason: 'testing' });
      expect((await suspend(moderator, student)).status).toBe(403); // moderators cannot suspend
      expect((await suspend(tenantAdmin, otherTenantAdmin)).status).toBe(403); // equal role is protected
      expect((await suspend(tenantAdmin, student)).status).toBe(204);
      const s = (await User.findById(student._id))!;
      expect(s.status).toBe('SUSPENDED');
      expect(Math.abs(s.suspendedUntil!.getTime() - (Date.now() + 3 * 86_400_000))).toBeLessThan(60_000);
    });

    it('lets a tenant admin lift a suspension, but only a super admin reverse a deactivation', async () => {
      const tenantAdmin = await makeUser({ role: 'TENANT_ADMIN' });
      const superAdmin = await makeUser({ role: 'SUPER_ADMIN' });
      const user = await makeUser();
      await Post.create({ authorId: user._id, content: 'mine', tenantDomain: 'test.edu' });
      const restore = (who: { _id: unknown }) =>
        request(app).post(`/api/v1/admin/users/${id(user)}/restore`).set('Authorization', bearer(who));

      await suspendUser({ userId: user._id, actorId: null });
      expect((await restore(tenantAdmin)).status).toBe(204);
      expect((await User.findById(user._id))!.status).toBe('ACTIVE');

      const deactivate = await request(app)
        .post(`/api/v1/admin/users/${id(user)}/deactivate`)
        .set('Authorization', bearer(tenantAdmin))
        .send({ reason: 'abuse' });
      expect(deactivate.status).toBe(204);
      expect(await BannedEmail.countDocuments()).toBe(1);
      expect((await Post.findOne({ authorId: user._id }))!.moderationStatus).toBe('REMOVED');

      expect((await restore(tenantAdmin)).status).toBe(403);
      expect((await restore(superAdmin)).status).toBe(204);
      const back = (await User.findById(user._id))!;
      expect(back.status).toBe('ACTIVE');
      expect(back.reportCount).toBe(0);
      expect(await BannedEmail.countDocuments()).toBe(0);
      expect((await Post.findOne({ authorId: user._id }))!.moderationStatus).toBe('PUBLISHED');
    });
  });
});
