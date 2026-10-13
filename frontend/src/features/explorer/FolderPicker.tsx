import { useState } from 'react';
import { ChevronRight, Folder, Home } from 'lucide-react';
import { useFolder } from '../../api/hooks';
import { cn } from '../../lib/cn';
import type { Crumb } from './use-breadcrumbs';

/**
 * Navegador de carpetas compacto para elegir destino. La carpeta "elegida"
 * es siempre aquella en la que se está, como en los diálogos del sistema.
 */
export function FolderPicker({ accountId, onChange, disabledIds = [] }: {
  accountId: string;
  onChange: (folder: Crumb) => void;
  disabledIds?: string[];
}) {
  const [trail, setTrail] = useState<Crumb[]>([{ id: 'root', name: 'Mi unidad' }]);
  const current = trail[trail.length - 1]!;
  const folders = useFolder(accountId, current.id, { orderBy: 'name', descending: false, includeTrashed: false });
  const subfolders = folders.data?.files.filter((f) => f.isFolder) ?? [];

  const goTo = (next: Crumb[]) => {
    setTrail(next);
    onChange(next[next.length - 1]!);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-raised">
      <nav aria-label="Ruta de destino" className="flex items-center gap-1 overflow-x-auto border-b border-line bg-sunken/40 px-3 py-2 text-[13px]">
        {trail.map((crumb, index) => (
          <span key={crumb.id} className="flex shrink-0 items-center gap-1">
            {index > 0 && <ChevronRight className="size-3.5 text-faint" />}
            <button
              type="button"
              onClick={() => goTo(trail.slice(0, index + 1))}
              className={cn('flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-sunken', index === trail.length - 1 ? 'font-medium text-ink' : 'text-muted')}
            >
              {index === 0 && <Home className="size-3.5" />}
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>
      <ul className="h-56 overflow-y-auto p-1.5" aria-busy={folders.isFetching}>
        {folders.isPending &&
          Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex h-9 items-center gap-2.5 px-2.5">
              <span className="skeleton size-4" />
              <span className="skeleton h-3 w-40" />
            </li>
          ))}
        {subfolders.map((folder) => {
          const disabled = disabledIds.includes(folder.id);
          return (
            <li key={folder.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => goTo([...trail, { id: folder.id, name: folder.name }])}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-sunken disabled:opacity-40"
              >
                <Folder className="size-4 text-[#e8c547]" strokeWidth={1.75} />
                <span className="flex-1 truncate">{folder.name}</span>
                <ChevronRight className="size-3.5 text-faint" />
              </button>
            </li>
          );
        })}
        {folders.isSuccess && subfolders.length === 0 && (
          <li className="grid h-full place-items-center text-sm text-faint">Sin subcarpetas</li>
        )}
      </ul>
    </div>
  );
}
