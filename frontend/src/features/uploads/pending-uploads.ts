/**
 * Subidas reanudables que siguen abiertas en el servidor, para retomarlas
 * tras recargar la página o cerrar el navegador.
 *
 * Solo se guarda el `uploadId` y cómo reconocer el archivo: el navegador no
 * puede volver a leer un `File` sin que el usuario lo elija de nuevo, así que
 * al retomarla se le pide y se comprueba que sea el mismo (nombre, tamaño y
 * fecha de modificación). Si el almacenamiento no está disponible, la subida
 * funciona igual; solo se pierde poder retomarla tras recargar.
 */
export interface PendingUpload {
  uploadId: string;
  accountId: string;
  folderId: string;
  name: string;
  size: number;
  lastModified: number;
  startedAt: string;
}

const KEY = 'stackdrive.pending-uploads';

function read(): PendingUpload[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingUpload[]) : [];
  } catch {
    return [];
  }
}

function write(list: PendingUpload[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* sin almacenamiento: no se podrá retomar tras recargar */
  }
}

export const pendingUploads = {
  list: read,
  save(entry: PendingUpload): void {
    write([...read().filter((p) => p.uploadId !== entry.uploadId), entry]);
  },
  remove(uploadId: string): void {
    write(read().filter((p) => p.uploadId !== uploadId));
  },
  clear(): void {
    write([]);
  },
  /** La subida abierta para este archivo en ese destino, si la hay. */
  match(accountId: string, folderId: string, file: File): PendingUpload | undefined {
    return read().find((p) => p.accountId === accountId && p.folderId === folderId && isSameFile(p, file));
  },
};

export function isSameFile(pending: Pick<PendingUpload, 'name' | 'size' | 'lastModified'>, file: File): boolean {
  return pending.name === file.name && pending.size === file.size && pending.lastModified === file.lastModified;
}
