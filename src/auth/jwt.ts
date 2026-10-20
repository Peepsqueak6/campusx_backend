import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface TokenPayload {
  sub: string;
  iat: number;
}

/** Module A issues real tokens. This helper exists for tests and local development. */
export function signToken(userId: string, expiresInSec = 15 * 60, iat?: number): string {
  const payload = iat === undefined ? {} : { iat };
  return jwt.sign(payload, config.jwtSecret, { subject: userId, expiresIn: expiresInSec });
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret);
  if (typeof decoded === 'string' || !decoded.sub || typeof decoded.iat !== 'number') {
    throw new Error('Malformed token');
  }
  return { sub: decoded.sub, iat: decoded.iat };
}
