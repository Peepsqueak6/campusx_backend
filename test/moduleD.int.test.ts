// Integration tests for Module D. They need MongoDB as a replica set (transactions) and Redis.
//   MONGO_TEST_URL="mongodb://127.0.0.1:27017/campusx_test?replicaSet=rs0" npm test
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signToken } from '../src/auth/jwt.js';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { Conversation, Follow, Message, ensureIndexes } from '../src/models/index.js';
import { attachSocketServer, SOCKET_PATH, type SocketServerHandle } from '../src/realtime/socket.js';
import { closeRedis, rateLimit } from '../src/redis.js';
import { MESSAGE_RATE } from '../src/constants.js';
import * as chat from '../src/services/chat.js';
import { suspendUser } from '../src/services/enforcement.js';
import { bearer, clearAll, id, makeUser, makeUsers } from './helpers.js';

const url = process.env.MONGO_TEST_URL;
const app = createApp();

/** Two users who follow each other, so their direct chat starts ACTIVE. */
async function mutualPair() {
  const [a, b] = await makeUsers(2);
  await Follow.create([
    { followerId: a!._id, followeeId: b!._id },
    { followerId: b!._id, followeeId: a!._id },
  ]);
  const { conversation } = await chat.createOrGetDirect(id(a!), id(b!));
  return { a: a!, b: b!, conv: conversation };
}

describe.skipIf(!url)('Module D', () => {
  beforeAll(async () => {
    await connectDb(url!);
    await ensureIndexes();
  });
  afterEach(clearAll);
  afterAll(async () => {
    await disconnectDb();
    await closeRedis();
  });

  describe('direct chats and message requests', () => {
    it('returns the same chat for a pair, whichever user opens it', async () => {
      const { a, b, conv } = await mutualPair();
      const again = await chat.createOrGetDirect(id(b), id(a));
      expect(again.created).toBe(false);
      expect(String(again.conversation._id)).toBe(String(conv._id));
      expect(conv.status).toBe('ACTIVE');
      expect(await Conversation.countDocuments({ isGroup: false })).toBe(1);
    });

    it('lets a non-follower send one request message, then waits for acceptance', async () => {
      const [a, b] = await makeUsers(2);
      const { conversation } = await chat.createOrGetDirect(id(a!), id(b!));
      expect(conversation.status).toBe('REQUESTED');
      const send = (who: { _id: unknown }, n: number) =>
        chat.sendMessage({ conversationId: id(conversation), senderId: id(who), clientMessageId: `c${n}`, text: `hello ${n}` });

      await send(a!, 1);
      await expect(send(a!, 2)).rejects.toMatchObject({ code: 'CHAT_REQUEST_PENDING' });
      await expect(send(b!, 3)).rejects.toMatchObject({ code: 'CHAT_REQUEST_PENDING' });

      await chat.respondToRequest(id(conversation), id(b!), true);
      await expect(send(b!, 4)).resolves.toBeTruthy();
      await expect(send(a!, 5)).resolves.toBeTruthy();
    });

    it('stops the requester from re-sending a declined request', async () => {
      const [a, b] = await makeUsers(2);
      const { conversation } = await chat.createOrGetDirect(id(a!), id(b!));
      await chat.respondToRequest(id(conversation), id(b!), false);
      await expect(chat.createOrGetDirect(id(a!), id(b!))).rejects.toMatchObject({ code: 'CHAT_REQUEST_DECLINED' });
    });

    it('blocks messages in both directions once a user is blocked', async () => {
      const { a, b, conv } = await mutualPair();
      await chat.blockUser(id(a), id(b));
      const send = (who: { _id: unknown }) =>
        chat.sendMessage({ conversationId: id(conv), senderId: id(who), clientMessageId: `b-${id(who)}`, text: 'hi' });
      await expect(send(a)).rejects.toMatchObject({ code: 'USER_BLOCKED' });
      await expect(send(b)).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    });
  });

  describe('messages', () => {
    it('stores one message when the same clientMessageId is sent twice', async () => {
      const { a, conv } = await mutualPair();
      const input = { conversationId: id(conv), senderId: id(a), clientMessageId: 'same', text: 'once' };
      const first = await chat.sendMessage(input);
      const second = await chat.sendMessage(input);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(String(second.message._id)).toBe(String(first.message._id));
      expect(await Message.countDocuments({ conversationId: conv._id, type: 'TEXT' })).toBe(1);
    });

    it('rejects the 21st message inside the rate-limit window', async () => {
      const { a, conv } = await mutualPair();
      // Use up the sender's 20-message allowance in one burst. Sending 20 real messages one by one would
      // depend on network speed: over a slow link the 10-second window expires before the 21st arrives.
      const used = await Promise.all(
        Array.from({ length: MESSAGE_RATE.limit }, () => rateLimit(`msg:${id(a)}`, MESSAGE_RATE.limit, MESSAGE_RATE.windowSec)),
      );
      expect(used.every(Boolean)).toBe(true);
      await expect(
        chat.sendMessage({ conversationId: id(conv), senderId: id(a), clientMessageId: 'm20', text: 'too many' }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('keeps history private to participants and masks deleted messages', async () => {
      const { a, conv } = await mutualPair();
      const stranger = await makeUser();
      const { message } = await chat.sendMessage({ conversationId: id(conv), senderId: id(a), clientMessageId: 'x', text: 'secret' });

      const denied = await request(app).get(`/api/v1/chats/${id(conv)}/messages`).set('Authorization', bearer(stranger));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('NOT_PARTICIPANT');

      await chat.deleteMessage(id(conv), id(message), id(a));
      const history = await request(app).get(`/api/v1/chats/${id(conv)}/messages`).set('Authorization', bearer(a));
      expect(history.status).toBe(200);
      expect(history.body.items[0]).toMatchObject({ deleted: true, text: '', media: null });
    });

    it('never moves a read pointer backward', async () => {
      const { a, b, conv } = await mutualPair();
      const sent = [];
      for (let i = 0; i < 3; i++) {
        sent.push((await chat.sendMessage({ conversationId: id(conv), senderId: id(a), clientMessageId: `r${i}`, text: `r${i}` })).message);
      }
      expect(await chat.markRead(id(conv), id(b), id(sent[2]!))).toBe(true);
      expect(await chat.markRead(id(conv), id(b), id(sent[0]!))).toBe(false);
      const fresh = (await Conversation.findById(conv._id))!;
      const mine = fresh.participants.find((p) => String(p.userId) === id(b))!;
      expect(String(mine.lastReadMessageId)).toBe(id(sent[2]!));
    });

    it('reports unread counts from the read pointer', async () => {
      const { a, b, conv } = await mutualPair();
      const sent = [];
      for (let i = 0; i < 3; i++) {
        sent.push((await chat.sendMessage({ conversationId: id(conv), senderId: id(a), clientMessageId: `u${i}`, text: `u${i}` })).message);
      }
      expect((await chat.listInbox(id(b), {})).items[0]!.unreadCount).toBe(3);
      await chat.markRead(id(conv), id(b), id(sent[1]!));
      expect((await chat.listInbox(id(b), {})).items[0]!.unreadCount).toBe(1);
      expect((await chat.listInbox(id(a), {})).items[0]!.unreadCount).toBe(0); // own messages never count
    });
  });

  describe('groups', () => {
    it('lets exactly one of two simultaneous adds take the 100th seat', async () => {
      const creator = await makeUser();
      const others = await makeUsers(98);
      const group = await chat.createGroup(id(creator), 'Everyone', others.map(id));
      expect(group.memberCount).toBe(99);

      const [u1, u2] = await makeUsers(2);
      const results = await Promise.allSettled([
        chat.addMembers(id(group), id(creator), [id(u1!)]),
        chat.addMembers(id(group), id(creator), [id(u2!)]),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'GROUP_FULL' });

      const fresh = (await Conversation.findById(group._id))!;
      expect(fresh.memberCount).toBe(100);
      expect(fresh.participantIds).toHaveLength(100);
      expect(fresh.participants).toHaveLength(100);
    });

    it('refuses to create a group over 100 members', async () => {
      const creator = await makeUser();
      const others = await makeUsers(100);
      await expect(chat.createGroup(id(creator), 'Too big', others.map(id))).rejects.toMatchObject({ code: 'GROUP_FULL' });
    });

    it('keeps at least one admin: the last admin cannot leave or be demoted', async () => {
      const creator = await makeUser();
      const [m1, m2] = await makeUsers(2);
      const group = await chat.createGroup(id(creator), 'Study group', [id(m1!), id(m2!)]);

      await expect(chat.removeMember(id(group), id(creator), id(creator))).rejects.toMatchObject({ code: 'LAST_ADMIN' });
      await expect(chat.setAdmin(id(group), id(creator), id(creator), false)).rejects.toMatchObject({ code: 'LAST_ADMIN' });

      await chat.setAdmin(id(group), id(creator), id(m1!), true);
      await chat.removeMember(id(group), id(creator), id(creator));
      const fresh = (await Conversation.findById(group._id))!;
      expect(fresh.memberCount).toBe(2);
      expect(fresh.adminIds.map(String)).toEqual([id(m1!)]);
    });

    it('lets only admins add and remove other members', async () => {
      const creator = await makeUser();
      const [member, newcomer] = await makeUsers(2);
      const group = await chat.createGroup(id(creator), 'Club', [id(member!)]);
      await expect(chat.addMembers(id(group), id(member!), [id(newcomer!)])).rejects.toMatchObject({ code: 'NOT_GROUP_ADMIN' });
      await expect(chat.removeMember(id(group), id(member!), id(creator))).rejects.toMatchObject({ code: 'NOT_GROUP_ADMIN' });
      await chat.removeMember(id(group), id(member!), id(member!)); // leaving is always allowed
      expect((await Conversation.findById(group._id))!.memberCount).toBe(1);
    });

    it('hands admin rights to another member when the only admin is suspended', async () => {
      const creator = await makeUser();
      const [m1, m2] = await makeUsers(2);
      const group = await chat.createGroup(id(creator), 'Class of 26', [id(m1!), id(m2!)]);
      await suspendUser({ userId: creator._id, actorId: null });
      const fresh = (await Conversation.findById(group._id))!;
      expect(fresh.adminIds).toHaveLength(2);
      expect(fresh.adminIds.map(String)).toContain(id(creator));
      expect([id(m1!), id(m2!)]).toContain(String(fresh.adminIds.find((a) => String(a) !== id(creator))));
    });
  });

  describe('realtime', () => {
    let server: Server;
    let handle: SocketServerHandle;
    let port: number;
    const clients: ClientSocket[] = [];

    beforeAll(async () => {
      server = createServer(app);
      handle = await attachSocketServer(server);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterEach(() => {
      clients.splice(0).forEach((c) => c.close());
    });
    afterAll(async () => {
      await handle.close();
      server.close();
    });

    const open = (user: { _id: unknown }, token = signToken(id(user))) =>
      new Promise<ClientSocket>((resolve, reject) => {
        const s = connectClient(`http://localhost:${port}`, { path: SOCKET_PATH, auth: { token }, transports: ['websocket'] });
        clients.push(s);
        s.once('READY', () => resolve(s));
        s.once('connect_error', reject);
      });
    const next = <T = unknown>(s: ClientSocket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));

    it('delivers a message, typing indicator and read receipt between two users', async () => {
      const { a, b, conv } = await mutualPair();
      const [sa, sb] = [await open(a), await open(b)];

      const incoming = next<{ text: string; senderId: string; clientMessageId: string }>(sa, 'NEW_MESSAGE');
      const ack = await new Promise<{ ok: boolean; messageId?: string }>((resolve) =>
        sb.emit('SEND_MESSAGE', { conversationId: id(conv), clientMessageId: 'ws-1', text: 'Are you going to #CSC301?' }, resolve),
      );
      expect(ack.ok).toBe(true);
      expect(await incoming).toMatchObject({ text: 'Are you going to #CSC301?', senderId: id(b), clientMessageId: 'ws-1' });

      const typing = next<{ userId: string; isTyping: boolean }>(sa, 'TYPING');
      sb.emit('TYPING_START', { conversationId: id(conv) });
      expect(await typing).toMatchObject({ userId: id(b), isTyping: true });

      const receipt = next<{ userId: string; lastReadMessageId: string }>(sb, 'READ_RECEIPT');
      sa.emit('MARK_READ', { conversationId: id(conv), messageId: ack.messageId });
      expect(await receipt).toMatchObject({ userId: id(a), lastReadMessageId: ack.messageId });
    });

    it('returns an error ack for a user who is not in the conversation', async () => {
      const { conv } = await mutualPair();
      const stranger = await makeUser();
      const s = await open(stranger);
      const ack = await new Promise<{ ok: boolean; error?: { code: string } }>((resolve) =>
        s.emit('SEND_MESSAGE', { conversationId: id(conv), clientMessageId: 'x', text: 'hi' }, resolve),
      );
      expect(ack).toMatchObject({ ok: false, error: { code: 'NOT_PARTICIPANT' } });
    });

    it('cuts a live socket when the account is suspended, and refuses new connections', async () => {
      const user = await makeUser();
      const s = await open(user);
      const forced = next<{ reason: string }>(s, 'FORCE_DISCONNECT');
      const closed = next(s, 'disconnect');
      await suspendUser({ userId: user._id, actorId: null });
      expect(await forced).toEqual({ reason: 'ACCOUNT_SUSPENDED' });
      await closed;

      await expect(open(user)).rejects.toMatchObject({ message: 'ACCOUNT_SUSPENDED' });
    });

    it('rejects a bad token at the handshake', async () => {
      const user = await makeUser();
      await expect(open(user, 'not-a-token')).rejects.toMatchObject({ message: 'AUTH_FAILED' });
    });
  });
});
