import mongoose, { type ClientSession } from 'mongoose';
import { config } from './config.js';

export async function connectDb(url: string = config.mongoUrl): Promise<void> {
  await mongoose.connect(url);
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

/**
 * Runs `fn` in a multi-document transaction (needs a replica set).
 * The result is captured outside the driver call so it works across driver versions.
 */
export async function withTx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export const isDuplicateKey = (err: unknown): boolean => (err as { code?: number })?.code === 11000;
