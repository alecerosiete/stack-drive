import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleAlert, CloudUpload, X } from 'lucide-react';
import { toast } from 'sonner';
import { invalidateAfterUpload } from '../../api/hooks';
import { formatBytes } from '../../lib/format';
import { cn } from '../../lib/cn';
import { uploads, useUploads, type UploadItem } from './upload-store';

/** Bandeja flotante de subidas: persiste mientras se navega por la app. */
export function UploadTray() {
  const items = useUploads();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(
    () =>
      uploads.onFinished((item) => {
        if (item.status === 'done') invalidateAfterUpload(queryClient, item.accountId);
        if (item.status === 'error') toast.error(`No se pudo subir «${item.name}»`, { description: item.error });
      }),
    [queryClient],
  );

  if (items.length === 0) return null;

  const pending = items.filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'processing');
  const totalBytes = pending.reduce((s, i) => s + i.size, 0);
  const loadedBytes = pending.reduce((s, i) => s + i.loaded, 0);
  const overall = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 100;

  return (
    <section
      aria-label="Subidas"
      aria-live="polite"
      className="card fixed right-4 bottom-4 z-30 w-[min(92vw,380px)] overflow-hidden animate-rise"
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <CloudUpload className="size-4 text-accent" />
        <h2 className="flex-1 text-sm font-medium">
          {pending.length > 0 ? `Subiendo ${pending.length} de ${items.length}` : `${items.length} subida${items.length === 1 ? '' : 's'} terminada${items.length === 1 ? '' : 's'}`}
        </h2>
        <button onClick={() => setCollapsed((c) => !c)} className="rounded-md p-1 text-faint hover:bg-sunken hover:text-ink" aria-label={collapsed ? 'Expandir' : 'Contraer'}>
          <ChevronDown className={cn('size-4 transition-transform', collapsed && 'rotate-180')} />
        </button>
        {pending.length === 0 && (
          <button onClick={() => uploads.clearFinished()} className="rounded-md p-1 text-faint hover:bg-sunken hover:text-ink" aria-label="Cerrar bandeja">
            <X className="size-4" />
          </button>
        )}
      </header>
      {pending.length > 0 && (
        <div className="h-0.5 bg-sunken">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${overall}%` }} />
        </div>
      )}
      {!collapsed && (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
          {items.map((item) => (
            <UploadRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const percent = item.size > 0 ? Math.round((item.loaded / item.size) * 100) : 0;
  const running = item.status === 'uploading' || item.status === 'processing' || item.status === 'queued';
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">{item.name}</p>
        <p className="mt-0.5 font-mono text-[11px] text-faint tabular">
          {item.status === 'queued' && 'En cola'}
          {item.status === 'uploading' && `${formatBytes(item.loaded)} / ${formatBytes(item.size)} · ${percent} %`}
          {item.status === 'processing' && 'Enviando a Google…'}
          {item.status === 'done' && formatBytes(item.size)}
          {item.status === 'cancelled' && 'Cancelada'}
          {item.status === 'error' && <span className="text-danger">{item.error}</span>}
        </p>
        {(item.status === 'uploading' || item.status === 'processing') && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sunken">
            <div
              className={cn('h-full rounded-full bg-accent transition-[width] duration-200', item.status === 'processing' && 'animate-stripes')}
              style={{
                width: `${item.status === 'processing' ? 100 : percent}%`,
                backgroundImage: item.status === 'processing' ? 'repeating-linear-gradient(90deg, transparent 0 8px, rgb(255 255 255 / 0.3) 8px 16px)' : undefined,
              }}
            />
          </div>
        )}
      </div>
      {item.status === 'done' && <Check className="size-4 text-ok" aria-label="Completada" />}
      {item.status === 'error' && <CircleAlert className="size-4 text-danger" aria-label="Error" />}
      {running && (
        <button onClick={() => uploads.cancel(item.id)} className="rounded-md p-1 text-faint hover:bg-sunken hover:text-danger" aria-label={`Cancelar ${item.name}`}>
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}
