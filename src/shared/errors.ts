import { GraphQLError } from 'graphql';

/**
 * Stable, client-facing error codes. Anything that is not one of these typed errors is masked
 * by Yoga as INTERNAL_SERVER_ERROR so internals never leak.
 */
export const ErrorCode = {
  BAD_USER_INPUT: 'BAD_USER_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  QUERY_TOO_COMPLEX: 'QUERY_TOO_COMPLEX',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

abstract class AppError extends GraphQLError {
  abstract readonly code: ErrorCode;
}

export class BadUserInputError extends AppError {
  readonly code = ErrorCode.BAD_USER_INPUT;
  constructor(message: string, extensions: Record<string, unknown> = {}) {
    super(message, { extensions: { code: ErrorCode.BAD_USER_INPUT, ...extensions } });
    this.name = 'BadUserInputError';
  }
}

export class NotFoundError extends AppError {
  readonly code = ErrorCode.NOT_FOUND;
  constructor(message: string, extensions: Record<string, unknown> = {}) {
    super(message, { extensions: { code: ErrorCode.NOT_FOUND, ...extensions } });
    this.name = 'NotFoundError';
  }
}

export class UpstreamError extends AppError {
  readonly code = ErrorCode.UPSTREAM_UNAVAILABLE;
  /** Whether repeating the request could plausibly succeed (network, timeout, 5xx, 429). */
  readonly retryable: boolean;

  constructor(
    readonly upstream: string,
    message: string,
    readonly status?: number,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(`${upstream}: ${message}`, {
      extensions: { code: ErrorCode.UPSTREAM_UNAVAILABLE, upstream },
    });
    this.name = 'UpstreamError';
    // Kept as `cause` (for logs) rather than `originalError`: Yoga masks GraphQLErrors that
    // wrap a non-GraphQL originalError, which would hide the stable UPSTREAM_UNAVAILABLE code.
    this.cause = options.cause;
    this.retryable = options.retryable ?? true;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
