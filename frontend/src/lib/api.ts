import { sessionStore, type Session } from './session';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/**
 * Error de la API con el `code` estable que emite el backend
 * (`src/common/errors.ts`), para ramificar sin parsear el mensaje.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get needsReauth(): boolean {
    return this.code === 'GOOGLE_ACCOUNT_NEEDS_REAUTH';
  }
}

interface ErrorBody {
  code?: string;
  message?: string | string[];
  detail?: string;
}

export async function toApiError(response: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    /* respuesta sin cuerpo JSON */
  }
  // ValidationPipe devuelve `message` como array de frases.
  const message = Array.isArray(body?.message)
    ? body.message.join(' · ')
    : body?.message || body?.detail || `Error HTTP ${response.status}`;
  return new ApiError(response.status, body?.code ?? null, message, body);
}

/**
 * Renovación "single-flight": si diez peticiones reciben 401 a la vez, solo
 * una llama a `/auth/refresh` y las demás esperan esa misma promesa. Sin esto
 * el backend rotaría el refresh token diez veces y nueve sesiones caerían.
 */
let refreshing: Promise<Session | null> | null = null;

export function refreshSession(): Promise<Session | null> {
  const session = sessionStore.get();
  if (!session) return Promise.resolve(null);

  refreshing ??= fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
    .then(async (response) => {
      if (!response.ok) throw await toApiError(response);
      const tokens = (await response.json()) as Session;
      const next = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
      sessionStore.set(next);
      return next;
    })
    .catch(() => {
      sessionStore.set(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });

  return refreshing;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** `fetch` autenticado que reintenta una vez tras renovar el token. */
export async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const { body, query, headers, ...init } = options;
  const isJson = body !== undefined && !(body instanceof FormData) && !(body instanceof Blob);

  const send = (token: string | undefined) =>
    fetch(buildUrl(path, query), {
      ...init,
      headers: {
        ...(isJson ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: isJson ? JSON.stringify(body) : (body as BodyInit | undefined),
    });

  let response = await send(sessionStore.get()?.accessToken);
  if (response.status === 401 && sessionStore.get()) {
    const renewed = await refreshSession();
    if (renewed) response = await send(renewed.accessToken);
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await rawRequest(path, options);
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? response.json() : response.text()) as Promise<T>;
}
