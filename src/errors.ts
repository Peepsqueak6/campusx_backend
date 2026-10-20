import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

/** Standard error shape: { error: { code, message, ...extra } } */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbiddenRole = () => new AppError(403, 'FORBIDDEN_ROLE', 'You do not have permission to do this');
export const notParticipant = () => new AppError(403, 'NOT_PARTICIPANT', 'You are not part of this conversation');

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request', issues: err.issues } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
