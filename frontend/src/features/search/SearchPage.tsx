import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ArrowDownToLine, ExternalLink, FolderOpen, SearchX } from 'lucide-react';
import { useSearch } from '../../api/hooks';
import type { DriveFile } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { downloadFile } from '../../lib/download';
import { formatBytes, formatRelative } from '../../lib/format';
import { Page, FailureList } from '../../components/ui/Page';
import { EmptyState } from '../../components/ui/EmptyState';
import { FileIcon } from '../explorer/file-icon';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const search = useSearch(q);
  const navigate = useNavigate();
  const [only, setOnly] = useState<string | null>(null);

  const pages = search.data?.results ?? [];
  const merged = useMemo(() => {
    const all = pages.flatMap((p) => p.files);
    return (only ? all.filter((f) => f.account.id === only) : all).sort(
      (a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''),
    );
  }, [pages, only]);

  const openFile = (file: DriveFile) => {
    if (file.isFolder) navigate(`/drive/${file.account.id}/${file.id}`);
    else if (file.webViewLink) window.open(file.webViewLink, '_blank', 'noopener,noreferrer');
  };

  if (!q) {
    return (
      <Page eyebrow="Buscar" title="Buscar en toda la pila">
        <div className="card">
          <EmptyState icon={<SearchX className="size-6" />} title="Escribe algo arriba">
            La búsqueda se lanza a la vez en todas tus cuentas activas. Pulsa <kbd className="font-mono">/</kbd> para ir al buscador.
          </EmptyState>
        </div>
      </Page>
    );
  }

  return (
    <Page
      eyebrow="Buscar"
      title={<>Resultados para <span className="text-accent">«{q}»</span></>}
      description={search.data ? `${merged.length} resultado${merged.length === 1 ? '' : 's'} en ${pages.length} cuenta${pages.length === 1 ? '' : 's'}` : 'Consultando todas las cuentas…'}
    >
      {search.data && <FailureList failures={search.data.failures} />}

      {pages.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por cuenta">
          <Chip active={only === null} onClick={() => setOnly(null)}>Todas</Chip>
          {pages.map((p) => (
            <Chip key={p.account.id} active={only === p.account.id} onClick={() => setOnly(only === p.account.id ? null : p.account.id)}>
              <span className="size-2 rounded-[2px]" style={{ background: accountColor(p.account.id) }} />
              {accountLabel(p.account)}
              <span className="font-mono text-faint">{p.files.length}</span>
            </Chip>
          ))}
        </div>
      )}

      {search.isPending ? (
        <div className="card divide-y divide-line">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
              <span className="skeleton size-5" />
              <span className="skeleton h-3.5 w-1/3" />
              <span className="skeleton ml-auto h-3 w-24" />
            </div>
          ))}
        </div>
      ) : merged.length === 0 ? (
        <div className="card">
          <EmptyState icon={<SearchX className="size-6" />} title="Sin resultados">Prueba con otra palabra o revisa la ortografía.</EmptyState>
        </div>
      ) : (
        <ul className={cn('card divide-y divide-line overflow-hidden transition-opacity', search.isPlaceholderData && 'opacity-60')}>
          {merged.map((file, i) => (
            <li key={`${file.account.id}:${file.id}`} className="group flex items-center gap-3 px-4 py-3 hover:bg-sunken/40 animate-rise" style={{ animationDelay: `${Math.min(i, 15) * 20}ms` }}>
              <FileIcon file={file} />
              <button onClick={() => openFile(file)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium group-hover:underline underline-offset-4">{file.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-faint">
                  <span className="size-2 rounded-[2px]" style={{ background: accountColor(file.account.id) }} />
                  {accountLabel(file.account)} · {formatRelative(file.modifiedTime)}
                </span>
              </button>
              <span className="hidden font-mono text-xs text-muted tabular sm:block">{file.isFolder ? '' : formatBytes(file.size)}</span>
              <div className="flex gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                {file.isFolder ? (
                  <Link to={`/drive/${file.account.id}/${file.id}`} className="rounded-md p-1.5 text-faint hover:bg-sunken hover:text-ink" aria-label="Abrir carpeta"><FolderOpen className="size-4" /></Link>
                ) : (
                  <button
                    className="rounded-md p-1.5 text-faint hover:bg-sunken hover:text-ink"
                    aria-label={`Descargar ${file.name}`}
                    onClick={() => toast.promise(downloadFile(file.account.id, file.id, file.name), { loading: 'Descargando…', success: 'Descarga completada', error: (e: Error) => e.message })}
                  >
                    <ArrowDownToLine className="size-4" />
                  </button>
                )}
                {file.parents[0] && (
                  <Link to={`/drive/${file.account.id}/${file.parents[0]}`} className="rounded-md p-1.5 text-faint hover:bg-sunken hover:text-ink" aria-label="Ir a la carpeta que lo contiene" title="Ir a la carpeta">
                    <ExternalLink className="size-4" />
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] transition-colors',
        active ? 'border-ink bg-ink text-canvas' : 'border-line bg-raised text-muted hover:border-line-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
