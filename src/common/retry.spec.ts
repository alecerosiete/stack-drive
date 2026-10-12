import { withRetry } from './retry';
import { isInvalidGrant, isRetryableGoogleError, normalizeGoogleError } from './google-error.util';

/** Construye un error con la forma que devuelve `googleapis` (GaxiosError). */
function googleError(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, data: body, headers },
  });
}

describe('normalizeGoogleError', () => {
  it('lee los errores del endpoint de token (OAuth)', () => {
    const error = googleError(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });

    expect(normalizeGoogleError(error)).toMatchObject({
      status: 400,
      oauthError: 'invalid_grant',
      message: 'Token has been expired or revoked.',
    });
  });

  it('lee los errores de la Drive API, con su razón', () => {
    const error = googleError(403, {
      error: {
        code: 403,
        message: 'Rate Limit Exceeded',
        errors: [{ reason: 'rateLimitExceeded' }],
      },
    });

    expect(normalizeGoogleError(error)).toMatchObject({
      status: 403,
      reason: 'rateLimitExceeded',
      message: 'Rate Limit Exceeded',
    });
  });

  it('interpreta la cabecera Retry-After en milisegundos', () => {
    const error = googleError(429, { error: { message: 'slow down' } }, { 'retry-after': '2' });

    expect(normalizeGoogleError(error).retryAfterMs).toBe(2000);
  });
});

describe('clasificación de errores', () => {
  it('reconoce invalid_grant como fallo definitivo de credencial', () => {
    expect(isInvalidGrant(googleError(400, { error: 'invalid_grant' }))).toBe(true);
    expect(isInvalidGrant(googleError(401, { error: 'unauthorized' }))).toBe(false);
  });

  it('considera transitorios los 429 y 5xx, y definitivos los 4xx de cliente', () => {
    expect(isRetryableGoogleError(googleError(429, {}))).toBe(true);
    expect(isRetryableGoogleError(googleError(503, {}))).toBe(true);
    expect(isRetryableGoogleError(googleError(404, {}))).toBe(false);
    expect(isRetryableGoogleError(googleError(400, {}))).toBe(false);
  });

  it('considera transitorios los cortes de red', () => {
    expect(isRetryableGoogleError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })))
      .toBe(true);
  });

  it('reconoce rateLimitExceeded aunque llegue con un 403', () => {
    // Google devuelve 403 (no 429) para algunos límites de cuota por usuario.
    const error = googleError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } });

    expect(isRetryableGoogleError(error)).toBe(true);
  });
});

describe('withRetry', () => {
  const options = { retries: 3, baseDelayMs: 1, operation: 'test' };

  it('devuelve el resultado sin reintentar si la primera llamada va bien', async () => {
    const task = jest.fn().mockResolvedValue('ok');

    await expect(withRetry(task, options)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('reintenta los fallos transitorios hasta que uno funciona', async () => {
    const task = jest
      .fn()
      .mockRejectedValueOnce(googleError(503, {}))
      .mockRejectedValueOnce(googleError(429, {}))
      .mockResolvedValue('ok');

    await expect(withRetry(task, options)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('no reintenta un error definitivo', async () => {
    const task = jest.fn().mockRejectedValue(googleError(404, { error: { message: 'no existe' } }));

    await expect(withRetry(task, options)).rejects.toThrow('HTTP 404');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('se rinde tras agotar los intentos y propaga el último error', async () => {
    const task = jest.fn().mockRejectedValue(googleError(503, {}));

    await expect(withRetry(task, { ...options, retries: 2 })).rejects.toThrow('HTTP 503');
    expect(task).toHaveBeenCalledTimes(3); // intento inicial + 2 reintentos
  });
});
