/**
 * Utilidades para interpretar los errores que devuelve `googleapis`.
 *
 * La librería lanza `GaxiosError`, cuya forma varía según si el fallo fue de
 * red, del endpoint de OAuth o de la Drive API. Centralizamos aquí la lectura
 * para que el resto del código no dependa de esa estructura.
 */

export interface NormalizedGoogleError {
  status?: number;
  /** Código corto de OAuth (`invalid_grant`, `invalid_client`...). */
  oauthError?: string;
  /** Razón del primer error de la Drive API (`rateLimitExceeded`...). */
  reason?: string;
  message: string;
  retryAfterMs?: number;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : undefined;
}

export function normalizeGoogleError(error: unknown): NormalizedGoogleError {
  const err = asRecord(error) ?? {};
  const response = asRecord(err.response);
  const data = asRecord(response?.data);
  const nestedError = asRecord(data?.error);

  const status: number | undefined =
    typeof err.status === 'number' ? err.status : (response?.status as number | undefined);

  // El endpoint de token devuelve {error, error_description};
  // la Drive API devuelve {error: {code, message, errors: [{reason}]}}.
  const oauthError =
    typeof data?.error === 'string'
      ? data.error
      : typeof err.code === 'string' && /^[a-z_]+$/.test(err.code)
        ? err.code
        : undefined;

  const reason = asRecord(nestedError?.errors?.[0])?.reason as string | undefined;

  const message =
    (typeof data?.error_description === 'string' ? data.error_description : undefined) ??
    (typeof nestedError?.message === 'string' ? nestedError.message : undefined) ??
    (typeof err.message === 'string' ? err.message : 'Error desconocido de Google');

  const retryAfterHeader = asRecord(response?.headers)?.['retry-after'];
  const retryAfterMs =
    retryAfterHeader !== undefined && Number.isFinite(Number(retryAfterHeader))
      ? Number(retryAfterHeader) * 1000
      : undefined;

  return { status, oauthError, reason, message, retryAfterMs };
}

/**
 * ¿El error indica que el `refresh_token` ya no es canjeable?
 *
 * Google responde `invalid_grant` cuando el usuario revocó el acceso, cambió
 * la contraseña, el token caducó por inactividad (6 meses) o la app sigue en
 * modo "testing" y pasaron 7 días. En todos esos casos no hay reintento que
 * lo arregle: hace falta un nuevo consentimiento.
 */
export function isInvalidGrant(error: unknown): boolean {
  const { oauthError, status, message } = normalizeGoogleError(error);
  if (oauthError === 'invalid_grant') return true;
  // Algunas respuestas no traen cuerpo parseable; el 400 del endpoint de token
  // con mensaje explícito es el otro caso observado en producción.
  return status === 400 && /invalid_grant/i.test(message);
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'internalError',
]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
]);

/** Fallos transitorios que merece la pena reintentar con backoff. */
export function isRetryableGoogleError(error: unknown): boolean {
  const { status, reason } = normalizeGoogleError(error);
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  if (reason && RETRYABLE_REASONS.has(reason)) return true;

  const code = asRecord(error)?.code;
  return typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code);
}
