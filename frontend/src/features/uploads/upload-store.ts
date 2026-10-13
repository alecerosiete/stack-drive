import { useSyncExternalStore } from 'react';
import { api, API_URL, refreshSession } from '../../lib/api';
import { sessionStore } from '../../lib/session';
import type { DriveFile } from '../../api/types';
import { isSameFile, pendingUploads } from './pending-uploads';
import { uploadResumable, xhrError } from './resumable';

/**
 * `interrupted`: subida reanudable que quedó a medias en una sesión anterior
 * del navegador. Para seguir hace falta que el usuario vuelva a elegir el
 * archivo (`uploads.resume`).
 */
export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  accountId: string;
  folderId: string;
  loaded: number;
  status: UploadStatus;
  error?: string;
  result?: DriveFile;
  /** Va por bloques: un corte no obliga a empezar de cero. */
  resumable: boolean;
  /** Esperando para reanudar tras un corte. */
  retrying?: boolean;
  /** Sesión en el servidor, para cancelarla o retomarla. */
  uploadId?: string;
  lastModified: number;
}

/**
 * Cola global de subidas. Vive fuera de React para que una subida siga en
 * curso aunque el usuario navegue a otra carpeta o pantalla.
 *
 * Usa XMLHttpRequest y no fetch porque fetch todavía no expone el progreso
 * de subida. Se suben de dos en dos: suficiente para aprovechar la conexión
 * sin que Google empiece a devolver 429 por ráfagas.
 *
 * Los archivos grandes van por bloques (`resumable.ts`) y sobreviven a cortes
 * y recargas; los pequeños, en una sola petición, porque repetirlos cuesta
 * menos que las peticiones extra de abrir y cerrar una sesión.
 */
const CONCURRENCY = 2;
const RESUMABLE_FROM = 8 * 1024 * 1024;

/** Las subidas reanudables que quedaron abiertas, a la espera del archivo. */
let items: UploadItem[] = pendingUploads.list().map((p) => ({
  id: p.uploadId,
  name: p.name,
  size: p.size,
  accountId: p.accountId,
  folderId: p.folderId,
  loaded: 0,
  status: 'interrupted',
  resumable: true,
  uploadId: p.uploadId,
  lastModified: p.lastModified,
}));
const requests = new Map<string, XMLHttpRequest>();
const controllers = new Map<string, AbortController>();
const files = new Map<string, File>();
const listeners = new Set<() => void>();
let onFinished: ((item: UploadItem) => void) | null = null;

function emit(): void {
  items = [...items];
  listeners.forEach((listener) => listener());
}

function patch(id: string, changes: Partial<UploadItem>): void {
  items = items.map((item) => (item.id === id ? { ...item, ...changes } : item));
  listeners.forEach((listener) => listener());
}

function send(item: UploadItem, file: File, token: string | undefined): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    requests.set(item.id, xhr);
    const query = new URLSearchParams({ parentId: item.folderId, name: file.name });
    xhr.open('POST', `${API_URL}/drive/${item.accountId}/files?${query}`);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      patch(item.id, { loaded: event.loaded });
      // Todo enviado: el servidor aún está reenviando los bytes a Google.
      if (event.lengthComputable && event.loaded >= event.total) patch(item.id, { status: 'processing' });
    };
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => reject(new Error('Fallo de red durante la subida'));
    xhr.onabort = () => reject(new DOMException('Cancelada', 'AbortError'));

    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

async function sendWhole(item: UploadItem, file: File): Promise<DriveFile> {
  let xhr = await send(item, file, sessionStore.get()?.accessToken);
  if (xhr.status === 401) {
    const renewed = await refreshSession();
    if (renewed) {
      patch(item.id, { loaded: 0 });
      xhr = await send(item, file, renewed.accessToken);
    }
  }
  if (xhr.status < 200 || xhr.status >= 300) throw xhrError(xhr);
  return JSON.parse(xhr.responseText) as DriveFile;
}

function sendInChunks(item: UploadItem, file: File): Promise<DriveFile> {
  const controller = new AbortController();
  controllers.set(item.id, controller);
  return uploadResumable(item, file, {
    signal: controller.signal,
    onSession: (uploadId) => patch(item.id, { uploadId }),
    // Último byte enviado: el servidor aún lo está reenviando a Google.
    onProgress: (loaded) => patch(item.id, { loaded, status: loaded >= item.size ? 'processing' : 'uploading' }),
    onRetrying: (retrying) => patch(item.id, { retrying }),
  });
}

async function run(item: UploadItem): Promise<void> {
  const file = files.get(item.id);
  if (!file) return;
  patch(item.id, { status: 'uploading' });

  try {
    const result = item.resumable ? await sendInChunks(item, file) : await sendWhole(item, file);
    patch(item.id, { status: 'done', loaded: item.size, retrying: false, result });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') patch(item.id, { status: 'cancelled' });
    else patch(item.id, { status: 'error', retrying: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    requests.delete(item.id);
    controllers.delete(item.id);
    const finished = items.find((i) => i.id === item.id);
    // Una subida por bloques que falla conserva en Google lo ya subido: se
    // guarda el archivo para poder reintentarla desde ahí (`uploads.retry`).
    if (!(finished?.status === 'error' && finished.resumable)) files.delete(item.id);
    if (finished) onFinished?.(finished);
    pump();
  }
}

function pump(): void {
  const running = items.filter((i) => i.status === 'uploading' || i.status === 'processing').length;
  const next = items.filter((i) => i.status === 'queued').slice(0, Math.max(0, CONCURRENCY - running));
  next.forEach((item) => void run(item));
}

// Al cerrar sesión se olvidan las subidas a medias: en un navegador
// compartido, la siguiente persona no debe ver los nombres de archivo de la
// anterior. Las sesiones del servidor caducan solas a la semana.
sessionStore.subscribe(() => {
  if (sessionStore.get()) return;
  pendingUploads.clear();
  if (items.some((i) => i.status === 'interrupted')) {
    items = items.filter((i) => i.status !== 'interrupted');
    emit();
  }
});

export const uploads = {
  enqueue(accountId: string, folderId: string, list: FileList | File[]): void {
    const added = Array.from(list).map<UploadItem>((file) => {
      const id = crypto.randomUUID();
      files.set(id, file);
      return {
        id,
        name: file.name,
        size: file.size,
        accountId,
        folderId,
        loaded: 0,
        status: 'queued',
        resumable: file.size > RESUMABLE_FROM,
        lastModified: file.lastModified,
      };
    });
    if (added.length === 0) return;
    // Volver a soltar un archivo que tenía una subida a medias la continúa
    // (`uploadResumable` la encuentra): su entrada "interrumpida" sobra.
    const resumed = new Set(
      added.flatMap((a) => {
        const file = files.get(a.id)!;
        return items.filter((i) => i.status === 'interrupted' && i.accountId === accountId && i.folderId === folderId && isSameFile(i, file)).map((i) => i.id);
      }),
    );
    items = [...items.filter((i) => !resumed.has(i.id)), ...added];
    emit();
    pump();
  },
  cancel(id: string): void {
    const item = items.find((i) => i.id === id);
    const xhr = requests.get(id);
    const controller = controllers.get(id);
    if (xhr) xhr.abort();
    else if (controller) controller.abort();
    else {
      files.delete(id);
      patch(id, { status: 'cancelled' });
    }
    // Cancelar libera también lo ya subido en Google; si falla, la sesión
    // caduca sola a la semana.
    if (item?.uploadId) {
      pendingUploads.remove(item.uploadId);
      void api(`/drive/${item.accountId}/uploads/${item.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  },
  /**
   * Retoma una subida interrumpida con el archivo que vuelve a elegir el
   * usuario. Devuelve `false` si no es el mismo archivo.
   */
  resume(id: string, file: File): boolean {
    const item = items.find((i) => i.id === id && i.status === 'interrupted');
    if (!item || !isSameFile(item, file)) return false;
    // Nuevo id de elemento: el de la sesión sigue en `uploadId`.
    const nextId = crypto.randomUUID();
    files.set(nextId, file);
    items = items.map((i) => (i.id === id ? { ...i, id: nextId, status: 'queued' } : i));
    emit();
    pump();
    return true;
  },
  /** Reintenta una subida por bloques fallida; sigue desde lo que tenga Google. */
  retry(id: string): void {
    const item = items.find((i) => i.id === id);
    if (item?.status !== 'error' || !files.has(id)) return;
    patch(id, { status: 'queued', error: undefined });
    pump();
  },
  clearFinished(): void {
    for (const item of items) if (item.status === 'error') files.delete(item.id);
    items = items.filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'processing' || i.status === 'interrupted');
    emit();
  },
  onFinished(callback: (item: UploadItem) => void): () => void {
    onFinished = callback;
    return () => {
      if (onFinished === callback) onFinished = null;
    };
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): UploadItem[] => items,
};

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(uploads.subscribe, uploads.get);
}
