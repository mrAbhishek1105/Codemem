import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../utils/logger.js';

export interface CodeMemError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  logger.error('http-server', `Request error: ${error.message}`, {
    url: request.url,
    method: request.method,
    code: error.code ?? 'UNKNOWN',
  });

  const statusCode = error.statusCode ?? 500;

  const body: { error: CodeMemError } = {
    error: {
      code: (error as unknown as Record<string, string>).errorCode ?? mapStatusToCode(statusCode),
      message: error.message ?? 'Internal server error',
    },
  };

  reply.status(statusCode).send(body);
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 404: return 'NOT_FOUND';
    case 503: return 'SERVICE_UNAVAILABLE';
    default: return 'INTERNAL_ERROR';
  }
}

/** Create a typed API error that will be handled by errorHandler */
export function createApiError(code: string, message: string, statusCode = 400): Error & { statusCode: number; errorCode: string } {
  const err = new Error(message) as Error & { statusCode: number; errorCode: string };
  err.statusCode = statusCode;
  err.errorCode = code;
  return err;
}
