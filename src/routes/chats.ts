import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me } from '../auth/middleware.js';
import { GROUP_NAME_MAX } from '../constants.js';
import * as chat from '../services/chat.js';
import { presignChatUpload } from '../services/storage.js';
import { objectIdSchema, parseObjectId } from '../util/helpers.js';

export const chatsRouter = Router();
chatsRouter.use(authenticate);

const idParam = (v: string | string[] | undefined) => parseObjectId(String(v));
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const mediaSchema = z.object({
  url: z.string().url(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().positive().optional(),
});

// Fixed paths first, so they are never read as a conversation id.

chatsRouter.post('/direct', async (req, res) => {
  const { userId } = z.object({ userId: objectIdSchema }).parse(req.body);
  const { conversation, created } = await chat.createOrGetDirect(me(req).id, userId);
  res.status(created ? 201 : 200).json(await chat.getConversationDetails(conversation._id, me(req).id));
});

chatsRouter.post('/group', async (req, res) => {
  const { name, memberIds } = z
    .object({ name: z.string().trim().min(1).max(GROUP_NAME_MAX), memberIds: z.array(objectIdSchema).min(1).max(99) })
    .parse(req.body);
  const conv = await chat.createGroup(me(req).id, name, memberIds);
  res.status(201).json(await chat.getConversationDetails(conv._id, me(req).id));
});

chatsRouter.post('/uploads/presign', async (req, res) => {
  const { mimeType, sizeBytes } = z.object({ mimeType: z.string(), sizeBytes: z.number().int() }).parse(req.body);
  res.json(await presignChatUpload(me(req).id, mimeType, sizeBytes));
});

chatsRouter.get('/', async (req, res) => {
  res.json(
    await chat.listInbox(me(req).id, { cursor: str(req.query.cursor), limit: req.query.limit, status: str(req.query.status) }),
  );
});

chatsRouter.get('/:id', async (req, res) => {
  res.json(await chat.getConversationDetails(idParam(req.params.id), me(req).id));
});

// ---------------------------------------------------------------- messages

chatsRouter.get('/:id/messages', async (req, res) => {
  res.json(await chat.listMessages(idParam(req.params.id), me(req).id, str(req.query.before), req.query.limit));
});

// REST fallback for when the socket is down. Same validation and idempotency as SEND_MESSAGE.
chatsRouter.post('/:id/messages', async (req, res) => {
  const body = z
    .object({ clientMessageId: z.string().min(1).max(64), text: z.string().optional(), media: mediaSchema.nullish() })
    .parse(req.body);
  const { message, duplicate } = await chat.sendMessage({
    conversationId: idParam(req.params.id),
    senderId: me(req).id,
    ...body,
  });
  res.status(duplicate ? 200 : 201).json({ message: chat.serializeMessage(message) });
});

chatsRouter.delete('/:id/messages/:messageId', async (req, res) => {
  await chat.deleteMessage(idParam(req.params.id), idParam(req.params.messageId), me(req).id);
  res.status(204).end();
});

chatsRouter.post('/:id/read', async (req, res) => {
  const { messageId } = z.object({ messageId: objectIdSchema }).parse(req.body);
  await chat.markRead(idParam(req.params.id), me(req).id, messageId);
  res.status(204).end();
});

// ---------------------------------------------------------------- message requests

chatsRouter.post('/:id/accept', async (req, res) => {
  await chat.respondToRequest(idParam(req.params.id), me(req).id, true);
  res.status(204).end();
});

chatsRouter.post('/:id/decline', async (req, res) => {
  await chat.respondToRequest(idParam(req.params.id), me(req).id, false);
  res.status(204).end();
});

// ---------------------------------------------------------------- group administration

chatsRouter.patch('/:id', async (req, res) => {
  const patch = z
    .object({ name: z.string().trim().min(1).max(GROUP_NAME_MAX).optional(), avatarUrl: z.string().url().nullable().optional() })
    .parse(req.body);
  await chat.updateGroup(idParam(req.params.id), me(req).id, patch);
  res.status(204).end();
});

chatsRouter.post('/:id/members', async (req, res) => {
  const { userIds } = z.object({ userIds: z.array(objectIdSchema).min(1).max(99) }).parse(req.body);
  res.json(await chat.addMembers(idParam(req.params.id), me(req).id, userIds));
});

chatsRouter.delete('/:id/members/:userId', async (req, res) => {
  await chat.removeMember(idParam(req.params.id), me(req).id, idParam(req.params.userId));
  res.status(204).end();
});

chatsRouter.post('/:id/admins', async (req, res) => {
  const { userId } = z.object({ userId: objectIdSchema }).parse(req.body);
  await chat.setAdmin(idParam(req.params.id), me(req).id, userId, true);
  res.status(204).end();
});

chatsRouter.delete('/:id/admins/:userId', async (req, res) => {
  await chat.setAdmin(idParam(req.params.id), me(req).id, idParam(req.params.userId), false);
  res.status(204).end();
});

// ---------------------------------------------------------------- blocks (mounted at /api/v1/users)

export const blocksRouter = Router();
blocksRouter.use(authenticate);

blocksRouter.post('/:id/block', async (req, res) => {
  await chat.blockUser(me(req).id, idParam(req.params.id));
  res.status(204).end();
});

blocksRouter.delete('/:id/block', async (req, res) => {
  await chat.unblockUser(me(req).id, idParam(req.params.id));
  res.status(204).end();
});
