import { useSyncExternalStore } from 'react';
import type { DriveFile } from '../../api/types';

/**
 * Petición de abrir el diálogo de transferencia. Vive fuera del explorador
 * porque se puede lanzar desde varios sitios: el menú de una fila, la barra
 * de selección múltiple, el atajo `T` o soltar elementos sobre una cuenta de
 * la barra lateral (que está en otra rama del árbol de React).
 */
export interface TransferIntent {
  accountId: string;
  items: DriveFile[];
  /** Cuenta destino ya elegida (al soltar sobre ella en la barra lateral). */
  targetId?: string;
  /** Se llama al encolar; el explorador lo usa para limpiar la selección. */
  onQueued?: () => void;
}

let current: TransferIntent | null = null;
const listeners = new Set<() => void>();

function emit(next: TransferIntent | null) {
  current = next;
  listeners.forEach((listener) => listener());
}

export const transferIntent = {
  open: (intent: TransferIntent) => emit(intent.items.length ? intent : null),
  close: () => emit(null),
};

export function useTransferIntent(): TransferIntent | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/**
 * Arrastre interno de elementos de StackDrive. Durante `dragover` el navegador
 * solo deja leer los TIPOS, no los datos: la cuenta de origen va codificada en
 * un tipo propio para que una cuenta pueda rechazar lo que viene de ella misma.
 */
export const DRAG_MIME = 'application/x-stackdrive-items';
const FROM_PREFIX = 'application/x-stackdrive-from-';

export function startItemsDrag(event: DragEvent | React.DragEvent, accountId: string, items: DriveFile[]) {
  const data = event.dataTransfer;
  if (!data) return;
  data.effectAllowed = 'copyMove';
  data.setData(DRAG_MIME, JSON.stringify({ accountId, items }));
  data.setData(FROM_PREFIX + accountId.toLowerCase(), '');

  // Fantasma compacto: con varios elementos, la captura por defecto de la
  // fila arrastrada daría a entender que solo se mueve uno.
  const ghost = document.createElement('div');
  ghost.textContent = items.length === 1 ? items[0]!.name : `${items.length} elementos`;
  ghost.className = 'drag-ghost';
  document.body.appendChild(ghost);
  data.setDragImage(ghost, 16, 16);
  setTimeout(() => ghost.remove(), 0);
}

export function isItemsDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(DRAG_MIME);
}

export function dragSourceAccount(event: React.DragEvent): string | null {
  const type = event.dataTransfer.types.find((t) => t.startsWith(FROM_PREFIX));
  return type ? type.slice(FROM_PREFIX.length) : null;
}

export function readItemsDrag(event: React.DragEvent): { accountId: string; items: DriveFile[] } | null {
  try {
    return JSON.parse(event.dataTransfer.getData(DRAG_MIME)) as { accountId: string; items: DriveFile[] };
  } catch {
    return null;
  }
}
