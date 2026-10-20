import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { authenticateToken, type AuthUser } from '../auth/middleware.js';
import { ENFORCEMENT_CHANNEL, TYPING_EXPIRY_MS } from '../constants.js';
import { AppError } from '../errors.js';
import { Conversation, User } from '../models/index.js';
import { newRedis, type EnforcementEvent } from '../redis.js';
import * as chat from '../services/chat.js';
import { objectIdSchema } from '../util/helpers.js';
import { convRoom, setIo, userRoom } from './bus.js';

/** Mounted at /ws/v1/chat. Events use the PRD's { event, payload } shape: `event` is the socket event name. */
export const SOCKET_PATH = '/ws/v1/chat';

const REASONS = {
  SUSPENDED: 'ACCOUNT_SUSPENDED',
  DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
} as const;

const mediaSchema = z.object({
  url: z.string().url(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().positive().optional(),
});
const sendSchema = z.object({
  conversationId: objectIdSchema,
  clientMessageId: z.string().min(1).max(64),
  text: z.string().optional(),
  media: mediaSchema.nullish(),
});
const convSchema = z.object({ conversationId: objectIdSchema });
const readSchema = z.object({ conversationId: objectIdSchema, messageId: objectIdSchema });

type Ack = (response: unknown) => void;

function errorPayload(err: unknown) {
  if (err instanceof AppError) return { code: err.code, message: err.message, ...err.extra };
  if (err instanceof z.ZodError) return { code: 'VALIDATION_FAILED', message: 'Invalid payload' };
  console.error(err);
  return { code: 'INTERNAL', message: 'Something went wrong' };
}

export interface SocketServerHandle {
  io: Server;
  close(): Promise<void>;
}

export async function attachSocketServer(
  httpServer: HttpServer,
  options: { redisAdapter?: boolean } = {},
): Promise<SocketServerHandle> {
  const io = new Server(httpServer, { path: SOCKET_PATH, serveClient: false });
  setIo(io);

  const redisClients: Redis[] = [];
  if (options.redisAdapter !== false) {
    // The adapter keeps rooms and broadcasts working when more than one server instance runs.
    const pub = newRedis();
    const sub = pub.duplicate();
    redisClients.push(pub, sub);
    io.adapter(createAdapter(pub, sub));
  }

  // Enforcement events: any process (REST server, job worker) publishes, each socket server drops its own sockets.
  const enforcementSub = newRedis();
  redisClients.push(enforcementSub);
  await enforcementSub.subscribe(ENFORCEMENT_CHANNEL);
  enforcementSub.on('message', (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as EnforcementEvent;
      const room = io.local.in(userRoom(event.userId));
      room.emit('FORCE_DISCONNECT', { reason: REASONS[event.action] });
      room.disconnectSockets(true);
    } catch (err) {
      console.error('bad enforcement event', err);
    }
  });

  // Handshake: signature, status (ACTIVE) and tokensInvalidBefore are all checked before the socket is accepted.
  io.use(async (socket, next) => {
    try {
      socket.data.user = await authenticateToken(socket.handshake.auth?.token);
      next();
    } catch (err) {
      const e = new Error(err instanceof AppError ? err.code : 'AUTH_FAILED') as Error & { data?: unknown };
      e.data = errorPayload(err);
      next(e);
    }
  });

  io.on('connection', (socket) => {
    void onConnection(socket);
  });

  return {
    io,
    async close() {
      setIo(null);
      await io.close();
      await Promise.all(redisClients.map((c) => c.quit().catch(() => undefined)));
    },
  };
}

async function onConnection(socket: Socket): Promise<void> {
  const user = socket.data.user as AuthUser;
  const typing = new Map<string, { timer: NodeJS.Timeout; lastEmit: number }>();
  let lastStatusCheck = Date.now();

  /** Runs a handler, then acks the result or the error. Without an ack function, errors arrive as an ERROR event. */
  const run =
    (handler: (payload: unknown) => Promise<Record<string, unknown> | void>) =>
    async (payload: unknown, ack?: Ack) => {
      try {
        // Backstop for a missed enforcement event: re-check the account at most every 5 seconds.
        if (Date.now() - lastStatusCheck > 5000) {
          lastStatusCheck = Date.now();
          if (!(await User.exists({ _id: user.id, status: 'ACTIVE' }))) {
            socket.emit('FORCE_DISCONNECT', { reason: 'TOKEN_REVOKED' });
            socket.disconnect(true);
            return;
          }
        }
        const result = (await handler(payload)) ?? {};
        if (typeof ack === 'function') ack({ ok: true, ...result });
      } catch (err) {
        const error = errorPayload(err);
        const clientMessageId = (payload as { clientMessageId?: string } | null)?.clientMessageId;
        if (typeof ack === 'function') ack({ ok: false, error });
        else socket.emit('ERROR', { ...error, ...(clientMessageId ? { clientMessageId } : {}) });
      }
    };

  const stopTyping = (conversationId: string, emit = true) => {
    const t = typing.get(conversationId);
    if (!t) return;
    clearTimeout(t.timer);
    typing.delete(conversationId);
    if (emit) socket.to(convRoom(conversationId)).emit('TYPING', { conversationId, userId: user.id, isTyping: false });
  };

  socket.on(
    'SEND_MESSAGE',
    run(async (raw) => {
      const input = sendSchema.parse(raw);
      stopTyping(input.conversationId);
      const { message } = await chat.sendMessage({ ...input, senderId: user.id });
      return { messageId: String(message._id), createdAt: message.createdAt };
    }),
  );

  socket.on(
    'TYPING_START',
    run(async (raw) => {
      const { conversationId } = convSchema.parse(raw);
      if (!socket.rooms.has(convRoom(conversationId))) throw new AppError(403, 'NOT_PARTICIPANT', 'You are not part of this conversation');
      const existing = typing.get(conversationId);
      if (existing) clearTimeout(existing.timer);
      const now = Date.now();
      // The indicator expires on its own if the client stops refreshing it.
      const timer = setTimeout(() => stopTyping(conversationId), TYPING_EXPIRY_MS);
      const lastEmit = existing?.lastEmit ?? 0;
      typing.set(conversationId, { timer, lastEmit: now - lastEmit >= 1000 ? now : lastEmit });
      if (now - lastEmit >= 1000) {
        socket.to(convRoom(conversationId)).emit('TYPING', { conversationId, userId: user.id, isTyping: true });
      }
    }),
  );

  socket.on(
    'TYPING_STOP',
    run(async (raw) => {
      stopTyping(convSchema.parse(raw).conversationId);
    }),
  );

  socket.on(
    'MARK_READ',
    run(async (raw) => {
      const { conversationId, messageId } = readSchema.parse(raw);
      await chat.markRead(conversationId, user.id, messageId); // emits READ_RECEIPT when the pointer moves
    }),
  );

  socket.on('disconnect', () => {
    for (const id of [...typing.keys()]) stopTyping(id);
  });

  // Join rooms last. Clients wait for READY before sending.
  socket.join(userRoom(user.id));
  const convs = await Conversation.find({ participantIds: user.id, status: { $ne: 'DECLINED' } })
    .select('_id')
    .limit(2000)
    .lean();
  await socket.join(convs.map((c) => convRoom(String(c._id))));
  socket.emit('READY', { userId: user.id });
}
