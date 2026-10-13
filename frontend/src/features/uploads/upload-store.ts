import { useSyncExternalStore } from 'react';
import { API_URL, ApiError, refreshSession } from '../../lib/api';
import { sessionStore } from '../../lib/session';
import type { DriveFile } from '../../api/types';

export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error' | 'cancelled';

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
}

/**
 * Cola global de subidas. Vive fuera de React para que una subida siga en
 * curso aunque el usuario navegue a otra carpeta o pantalla.
 *
 * Usa XMLHttpRequest y no fetch porque fetch todavía no expone el progreso
 * de subida. Se suben de dos en dos: suficiente para aprovechar la conexión
 * sin que Google empiece a devolver 429 por ráfagas.
 */
const CONCURRENCY = 2;

let items: UploadItem[] = [];
const requests = new Map<string, XMLHttpRequest>();
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

async function run(item: UploadItem): Promise<void> {
  const file = files.get(item.id);
  if (!file) return;
  patch(item.id, { status: 'uploading' });

  try {
    let xhr = await send(item, file, sessionStore.get()?.accessToken);
    if (xhr.status === 401) {
      const renewed = await refreshSession();
      if (renewed) {
        patch(item.id, { loaded: 0 });
        xhr = await send(item, file, renewed.accessToken);
      }
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      let message = `Error HTTP ${xhr.status}`;
      let code: string | null = null;
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string | string[]; code?: string };
        message = Array.isArray(body.message) ? body.message.join(' · ') : body.message || message;
        code = body.code ?? null;
      } catch {
        /* cuerpo no JSON */
      }
      throw new ApiError(xhr.status, code, message);
    }
    patch(item.id, { status: 'done', loaded: item.size, result: JSON.parse(xhr.responseText) as DriveFile });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') patch(item.id, { status: 'cancelled' });
    else patch(item.id, { status: 'error', error: error instanceof Error ? error.message : String(error) });
  } finally {
    requests.delete(item.id);
    files.delete(item.id);
    const finished = items.find((i) => i.id === item.id);
    if (finished) onFinished?.(finished);
    pump();
  }
}

function pump(): void {
  const running = items.filter((i) => i.status === 'uploading' || i.status === 'processing').length;
  const next = items.filter((i) => i.status === 'queued').slice(0, Math.max(0, CONCURRENCY - running));
  next.forEach((item) => void run(item));
}

export const uploads = {
  enqueue(accountId: string, folderId: string, list: FileList | File[]): void {
    const added = Array.from(list).map<UploadItem>((file) => {
      const id = crypto.randomUUID();
      files.set(id, file);
      return { id, name: file.name, size: file.size, accountId, folderId, loaded: 0, status: 'queued' };
    });
    if (added.length === 0) return;
    items = [...items, ...added];
    emit();
    pump();
  },
  cancel(id: string): void {
    const xhr = requests.get(id);
    if (xhr) xhr.abort();
    else {
      files.delete(id);
      patch(id, { status: 'cancelled' });
    }
  },
  clearFinished(): void {
    items = items.filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'processing');
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
