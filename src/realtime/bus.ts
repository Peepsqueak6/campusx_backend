import type { Server } from 'socket.io';

/**
 * Lets REST handlers and services push events to connected sockets without importing the socket server.
 * `attachSocketServer` registers the Server here. Without it (REST-only process, tests) every call is a no-op.
 */
let io: Server | null = null;

export const setIo = (server: Server | null): void => {
  io = server;
};

export const userRoom = (userId: string) => `user:${userId}`;
export const convRoom = (conversationId: string) => `conv:${conversationId}`;

export const emitToConversation = (conversationId: string, event: string, payload: unknown): void => {
  io?.to(convRoom(conversationId)).emit(event, payload);
};

export const emitToUser = (userId: string, event: string, payload: unknown): void => {
  io?.to(userRoom(userId)).emit(event, payload);
};

/** Puts all of a user's connected sockets (on any server instance) into a conversation room. */
export const joinUserToConversation = (userId: string, conversationId: string): void => {
  io?.in(userRoom(userId)).socketsJoin(convRoom(conversationId));
};

export const removeUserFromConversation = (userId: string, conversationId: string): void => {
  io?.in(userRoom(userId)).socketsLeave(convRoom(conversationId));
};
