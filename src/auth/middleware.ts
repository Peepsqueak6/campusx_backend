import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, forbiddenRole } from '../errors.js';
import { ROLE_RANK, type BadgeType, type Role } from '../constants.js';
import { User } from '../models/index.js';
import { getTokensInvalidBefore } from '../redis.js';
import { verifyToken } from './jwt.js';

export interface AuthUser {
  id: string;
  tenantDomain: string;
  role: Role;
  badgeType: BadgeType;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Verifies a bearer token and loads the user. Shared by the REST middleware and the socket handshake.
 * Order matters: status is checked before revocation so a suspended user gets a clear error
 * (with the end date) instead of a generic "token revoked".
 */
export async function authenticateToken(token: string | undefined): Promise<AuthUser> {
  if (!token) throw new AppError(401, 'AUTH_FAILED', 'Missing token');

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new AppError(401, 'AUTH_FAILED', 'Invalid or expired token');
  }

  const user = await User.findById(payload.sub)
    .select('role status tenantDomain badge suspendedUntil tokensInvalidBefore')
    .lean();
  if (!user) throw new AppError(401, 'AUTH_FAILED', 'Unknown user');

  if (user.status === 'SUSPENDED') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended', {
      suspendedUntil: user.suspendedUntil,
    });
  }
  if (user.status === 'DEACTIVATED') {
    throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
  }

  // Redis holds the fast copy. If Redis is down we still have the value on the user document.
  let redisValue: number | null = null;
  try {
    redisValue = await getTokensInvalidBefore(payload.sub);
  } catch {
    /* fall back to the database value */
  }
  const invalidBefore = Math.max(user.tokensInvalidBefore?.getTime() ?? 0, redisValue ?? 0);
  // JWT `iat` has one-second resolution, so compare in whole seconds.
  if (invalidBefore > 0 && payload.iat <= Math.floor(invalidBefore / 1000)) {
    throw new AppError(401, 'TOKEN_REVOKED', 'This session was ended. Please log in again');
  }

  return {
    id: String(user._id),
    tenantDomain: user.tenantDomain,
    role: user.role as Role,
    badgeType: (user.badge?.type ?? 'NONE') as BadgeType,
  };
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    req.user = await authenticateToken(token);
    next();
  } catch (err) {
    next(err);
  }
};

/** Allows the route only for users at or above `min`. */
export const requireRole =
  (min: Role): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || ROLE_RANK[req.user.role] < ROLE_RANK[min]) return next(forbiddenRole());
    next();
  };

/** The authenticated user. Throws if `authenticate` did not run (a programming error). */
export function me(req: Request): AuthUser {
  if (!req.user) throw new AppError(401, 'AUTH_FAILED', 'Not authenticated');
  return req.user;
}
