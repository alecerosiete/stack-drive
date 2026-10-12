import { Logger } from '@nestjs/common';
import { isRetryableGoogleError, normalizeGoogleError } from './google-error.util';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  operation: string;
  logger?: Logger;
  isRetryable?: (error: unknown) => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reintenta una llamada a Google con backoff exponencial y jitter.
 *
 * El jitter evita que todas las peticiones de todos los tenants reintenten en
 * el mismo instante tras un 429 (efecto manada). Si Google envía `Retry-After`
 * respetamos ese valor, que es más fiable que nuestra heurística.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, baseDelayMs, operation, logger } = options;
  const isRetryable = options.isRetryable ?? isRetryableGoogleError;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === retries || !isRetryable(error)) {
        throw error;
      }

      const { retryAfterMs, status, message } = normalizeGoogleError(error);
      const backoff = baseDelayMs * 2 ** attempt;
      const jitter = Math.random() * baseDelayMs;
      const delay = retryAfterMs ?? backoff + jitter;

      logger?.warn(
        `${operation}: intento ${attempt + 1}/${retries + 1} falló (status=${status ?? 'n/a'}: ${message}). ` +
          `Reintentando en ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
