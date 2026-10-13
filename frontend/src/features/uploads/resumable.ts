import { api, API_URL, ApiError, refreshSession } from '../../lib/api';
import { sessionStore } from '../../lib/session';
import type { DriveFile } from '../../api/types';
import { pendingUploads } from './pending-uploads';

/** Vista de `src/drive/upload-session.types.ts`. */
interface UploadSession {
  id: string;
  offset: number;
  size: number;
  chunkSize: number;
  file?: DriveFile;
}

export interface ResumableHooks {
  signal: AbortSignal;
  /** Se conoce el id de la sesión (para poder cancelarla en el servidor). */
  onSession: (uploadId: string) => void;
  /** Bytes que ya tiene Google, más los del bloque en vuelo. */
  onProgress: (loaded: number) => void;
  /** `true` mientras se espera para reanudar tras un corte. */
  onRetrying: (retrying: boolean) => void;
}

/**
 * Intentos seguidos SIN avance antes de rendirse. Como en el servidor, un
 * corte que deja bytes nuevos confirmados no cuenta: una red mala que va
 * avanzando termina llegando.
 */
const MAX_STALLS = 6;

/**
 * Sube `file` por bloques a través de la API y, tras un corte, pregunta
 * cuántos bytes confirmó Google y sigue desde ahí. Si ya había una subida
 * abierta para este mismo archivo y destino (p. ej. antes de recargar la
 * página), la continúa en vez de empezar de cero.
 */
export async function uploadResumable(
  target: { accountId: string; folderId: string },
  file: File,
  hooks: ResumableHooks,
): Promise<DriveFile> {
  const { signal } = hooks;
  let session = await open(target, file, signal);
  let restarted = false;
  let stalls = 0;
  hooks.onSession(session.id);

  for (;;) {
    if (session.file) return finish(session);
    hooks.onProgress(session.offset);

    const start = session.offset;
    const end = Math.min(start + session.chunkSize, file.size);
    try {
      session = { ...session, ...(await sendChunk(target.accountId, session, file.slice(start, end), start, hooks)) };
      if (session.offset > start) stalls = 0;
      hooks.onRetrying(false);
      continue;
    } catch (error) {
      if (signal.aborted) throw error;
      if (!isRetryable(error) && !isLost(error)) throw error;
    }

    // Tras un corte no se sabe cuánto llegó a Google: se pregunta antes de
    // enviar nada más, para no reenviar bytes ya confirmados ni dejar huecos.
    for (;;) {
      hooks.onRetrying(true);
      await waitUntilOnline(signal);
      await sleep(backoff(stalls), signal);
      try {
        const status = await api<UploadSession>(`/drive/${target.accountId}/uploads/${session.id}`, { signal });
        if (status.offset <= session.offset) stalls += 1;
        else stalls = 0;
        session = status;
        break;
      } catch (error) {
        if (signal.aborted) throw error;
        if (isLost(error) && !restarted) {
          // Google descartó la sesión (caducó): se empieza de cero una vez.
          restarted = true;
          pendingUploads.remove(session.id);
          session = await open(target, file, signal);
          hooks.onSession(session.id);
          break;
        }
        if (!isRetryable(error)) throw error;
        stalls += 1;
      }
      if (stalls > MAX_STALLS) throw new Error('La conexión no se recupera; la subida queda a medias para retomarla más tarde');
    }
    if (stalls > MAX_STALLS) throw new Error('La subida no avanza tras varios intentos; puedes retomarla más tarde');
  }

  function finish(done: UploadSession): DriveFile {
    pendingUploads.remove(done.id);
    hooks.onRetrying(false);
    return done.file!;
  }
}

/** Continúa la sesión abierta para este archivo, o abre una nueva. */
async function open(
  target: { accountId: string; folderId: string },
  file: File,
  signal: AbortSignal,
): Promise<UploadSession> {
  const pending = pendingUploads.match(target.accountId, target.folderId, file);
  if (pending) {
    try {
      return await api<UploadSession>(`/drive/${target.accountId}/uploads/${pending.uploadId}`, { signal });
    } catch (error) {
      if (!isLost(error)) throw error;
      pendingUploads.remove(pending.uploadId);
    }
  }

  const session = await api<UploadSession>(`/drive/${target.accountId}/uploads`, {
    method: 'POST',
    body: { name: file.name, size: file.size, mimeType: file.type || undefined, parentId: target.folderId },
    signal,
  });
  pendingUploads.save({
    uploadId: session.id,
    accountId: target.accountId,
    folderId: target.folderId,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    startedAt: new Date().toISOString(),
  });
  return session;
}

/**
 * Un bloque por XMLHttpRequest, que (a diferencia de fetch) informa del
 * progreso de subida. Si el token de la plataforma caducó, se renueva y se
 * repite el bloque una vez: eso no es un corte.
 */
function sendChunk(
  accountId: string,
  session: UploadSession,
  blob: Blob,
  start: number,
  hooks: ResumableHooks,
): Promise<UploadSession> {
  const attempt = (token: string | undefined, renewed: boolean): Promise<UploadSession> =>
    new Promise<XMLHttpRequest>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      hooks.signal.addEventListener('abort', abort, { once: true });
      xhr.onloadend = () => hooks.signal.removeEventListener('abort', abort);

      xhr.open('PUT', `${API_URL}/drive/${accountId}/uploads/${session.id}`);
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('content-range', `bytes ${start}-${start + blob.size - 1}/${session.size}`);
      xhr.upload.onprogress = (event) => hooks.onProgress(start + event.loaded);
      xhr.onload = () => resolve(xhr);
      xhr.onerror = () => reject(new TypeError('Fallo de red durante la subida'));
      xhr.onabort = () => reject(new DOMException('Cancelada', 'AbortError'));
      xhr.send(blob);
    }).then(async (xhr) => {
      if (xhr.status === 401 && !renewed) {
        const fresh = await refreshSession();
        if (fresh) return attempt(fresh.accessToken, true);
      }
      if (xhr.status < 200 || xhr.status >= 300) throw xhrError(xhr);
      return JSON.parse(xhr.responseText) as UploadSession;
    });

  return attempt(sessionStore.get()?.accessToken, false);
}

/** Error de la API a partir de una respuesta de XMLHttpRequest. */
export function xhrError(xhr: XMLHttpRequest): ApiError {
  let message = `Error HTTP ${xhr.status}`;
  let code: string | null = null;
  try {
    const body = JSON.parse(xhr.responseText) as { message?: string | string[]; code?: string };
    message = Array.isArray(body.message) ? body.message.join(' · ') : body.message || message;
    code = body.code ?? null;
  } catch {
    /* cuerpo no JSON */
  }
  return new ApiError(xhr.status, code, message);
}

/** Cortes de red, fallos aguas arriba y `UPLOAD_INTERRUPTED` (502). */
function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch/XHR sin respuesta
  return error instanceof ApiError && (error.status >= 500 || error.status === 408 || error.status === 429);
}

/** La sesión ya no existe en el servidor o en Google. */
function isLost(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 410);
}

function backoff(stalls: number): number {
  return Math.min(30_000, 1000 * 2 ** stalls) + Math.random() * 500;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(new DOMException('Cancelada', 'AbortError'));
    }
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Sin conexión no tiene sentido gastar intentos: se espera a recuperarla. */
function waitUntilOnline(signal: AbortSignal): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const online = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      window.removeEventListener('online', online);
      reject(new DOMException('Cancelada', 'AbortError'));
    };
    window.addEventListener('online', online, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}
