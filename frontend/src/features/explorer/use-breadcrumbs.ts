import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keys } from '../../api/hooks';
import { api } from '../../lib/api';
import type { DriveFile } from '../../api/types';

export interface Crumb {
  id: string;
  name: string;
}

const MAX_DEPTH = 12;

/**
 * Ruta desde la raíz hasta la carpeta actual, reconstruida subiendo por
 * `parents`. Así la URL `/drive/:cuenta/:carpeta` es enlazable y sobrevive a
 * recargar, sin guardar el historial de navegación en ningún sitio. Cada
 * paso usa la misma caché que `useFile`, de modo que navegar hacia dentro
 * solo pide a la API la carpeta nueva.
 */
export function useBreadcrumbs(accountId: string, folderId: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...keys.drive(accountId), 'path', folderId],
    enabled: folderId !== 'root',
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Crumb[]> => {
      const trail: Crumb[] = [];
      let currentId: string | undefined = folderId;
      for (let depth = 0; currentId && depth < MAX_DEPTH; depth += 1) {
        const id: string = currentId;
        const file = await qc.fetchQuery({
          queryKey: keys.file(accountId, id),
          queryFn: () => api<DriveFile>(`/drive/${accountId}/files/${id}`),
          staleTime: 5 * 60_000,
        });
        // La raíz real ("Mi unidad") no tiene padres: no se muestra como
        // miga propia porque ya está la de la cuenta.
        if (file.parents.length === 0) break;
        trail.unshift({ id: file.id, name: file.name });
        currentId = file.parents[0];
      }
      return trail;
    },
  });
}
