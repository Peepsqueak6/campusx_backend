import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';

export type IdLike = string | Types.ObjectId;

/** SHA-256 of the trimmed, lowercased email. Used for the ban list so it never stores raw emails. */
export const emailHash = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** Order-independent key for a pair of users, so one direct chat exists per pair. */
export const directKey = (a: IdLike, b: IdLike): string => {
  const [lo, hi] = [String(a), String(b)].sort();
  return `${lo}:${hi}`;
};

export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const toObjectId = (id: IdLike): Types.ObjectId => new Types.ObjectId(String(id));

export function parseObjectId(id: string, what = 'id'): Types.ObjectId {
  if (!Types.ObjectId.isValid(id) || String(new Types.ObjectId(id)) !== id.toLowerCase()) {
    throw new AppError(422, 'VALIDATION_FAILED', `Invalid ${what}`);
  }
  return new Types.ObjectId(id);
}

export const sameId = (a: IdLike | null | undefined, b: IdLike | null | undefined): boolean =>
  a != null && b != null && String(a) === String(b);

/** Cursor for lists ordered by (date desc, _id desc). */
export const encodeCursor = (date: Date, id: IdLike): string =>
  Buffer.from(`${date.getTime()}:${String(id)}`).toString('base64url');

export function decodeCursor(cursor: string): { date: Date; id: Types.ObjectId } {
  const [ms, id] = Buffer.from(cursor, 'base64url').toString().split(':');
  if (!ms || !id || Number.isNaN(Number(ms)) || !Types.ObjectId.isValid(id)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Invalid cursor');
  }
  return { date: new Date(Number(ms)), id: new Types.ObjectId(id) };
}

export const clampLimit = (raw: unknown, def: number, max: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};
