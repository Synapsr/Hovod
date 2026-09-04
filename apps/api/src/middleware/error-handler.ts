import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from '../env.js';

export class AppError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    if (error instanceof ZodError) {
      const response: { error: string; details?: Record<string, string[]> } = {
        error: 'Validation failed',
      };
      if (env.NODE_ENV !== 'production') {
        response.details = error.flatten().fieldErrors as Record<string, string[]>;
      }
      return reply.code(400).send(response);
    }

    // Framework/plugin errors carry their own status (429 rate limit, 413 body too large,
    // 400 malformed JSON, 415 unsupported media type) — surface them instead of a 500.
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: (error as Error).message || 'Request failed' });
    }

    request.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });
}
