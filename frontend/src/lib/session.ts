import { useSyncExternalStore } from 'react';

/**
 * Almacén de la sesión de StackDrive (no de Google).
 *
 * Vive fuera de React para que el cliente HTTP pueda leer y renovar los
 * tokens sin pasar por el árbol de componentes; los componentes se suscriben
 * con `useSession()` vía `useSyncExternalStore`.
 *
 * Los tokens se guardan en localStorage para sobrevivir a recargas. Es el
 * mismo trade-off que aceptaba el panel anterior: en producción conviene un
 * refresh token en cookie httpOnly, pero eso exige cambios en la API.
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
}

const STORAGE_KEY = 'stackdrive.session.v1';
type Listener = () => void;

const listeners = new Set<Listener>();
let current: Session | null = read();

function read(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    return parsed.accessToken && parsed.refreshToken
      ? { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
      : null;
  } catch {
    return null;
  }
}

export const sessionStore = {
  get: (): Session | null => current,
  set(next: Session | null): void {
    current = next;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* almacenamiento bloqueado: la sesión dura lo que la pestaña */
    }
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// Otra pestaña cerró o inició sesión: nos sincronizamos con ella.
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  current = read();
  listeners.forEach((listener) => listener());
});

export function useSession(): Session | null {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
}
