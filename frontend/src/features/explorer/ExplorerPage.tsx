import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { useAccountQuota, useAccounts, useDeleteFile, useEmptyTrash, useFolder, useUpdateFile, type FolderOptions } from '../../api/hooks';
import type { DriveFile } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { downloadFile } from '../../lib/download';
import { formatBytes, formatPercent, formatRelative } from '../../lib/format';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Menu, type MenuItem } from '../../components/ui/Menu';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { QuotaBreakdown } from '../../components/ui/StackMeter';
import { AccountAvatar } from '../../components/ui/AccountAvatar';
import { inputClass } from '../../components/ui/Field';
import { uploads } from '../uploads/upload-store';
import { FileIcon, fileKind } from './file-icon';
import { useBreadcrumbs } from './use-breadcrumbs';
import { MoveDialog, NewFolderDialog, RenameDialog } from './dialogs';
import { startItemsDrag, transferIntent } from '../transfers/transfer-intent';

type View = 'list' | 'grid';
type Sort = FolderOptions['orderBy'];

const SORTS: Array<{ value: Sort; label: string; descending: boolean }> = [
  { value: 'folder,name', label: 'Nombre', descending: false },
  { value: 'modifiedTime', label: 'Modificación', descending: true },
  { value: 'quotaBytesUsed', label: 'Tamaño', descending: true },
];

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferencia no persistente */
  }
}

export function ExplorerPage() {
  const { accountId = '', folderId = 'root' } = useParams();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const account = accounts.data?.find((a) => a.id === accountId);
  const quota = useAccountQuota(accountId);

  const [view, setView] = useState<View>(() => readPref('stackdrive.view', 'list', ['list', 'grid'] as const));
  const [sort, setSort] = useState<Sort>(() => readPref('stackdrive.sort', 'folder,name', ['folder,name', 'modifiedTime', 'quotaBytesUsed'] as const));
  const [showTrashed, setShowTrashed] = useState(false);
  const emptyTrash = useEmptyTrash(accountId);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  /** Selección múltiple (casillas). `selected` es solo el foco del teclado. */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renaming, setRenaming] = useState<DriveFile | null>(null);
  const [moving, setMoving] = useState<DriveFile | null>(null);
  const [deleting, setDeleting] = useState<DriveFile | null>(null);

  // Al cambiar de carpeta, la selección y el filtro de la anterior ya no aplican.
  useEffect(() => {
    setSelected(null);
    setChecked(new Set());
    anchor.current = null;
    setFilter('');
  }, [accountId, folderId]);

  const sortDef = SORTS.find((s) => s.value === sort) ?? SORTS[0]!;
  const folder = useFolder(accountId, folderId, { orderBy: sort, descending: sortDef.descending, includeTrashed: showTrashed });
  const crumbs = useBreadcrumbs(accountId, folderId);
  const update = useUpdateFile(accountId);
  const remove = useDeleteFile(accountId);

  const files = useMemo(() => {
    const all = folder.data?.files ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((f) => f.name.toLowerCase().includes(q)) : all;
  }, [folder.data, filter]);

  const checkedFiles = useMemo(
    () => (folder.data?.files ?? []).filter((f) => checked.has(f.id)),
    [folder.data, checked],
  );

  /** Clic con modificadores, como en un explorador de escritorio. */
  const toggle = (file: DriveFile, index: number, event: { shiftKey: boolean }) => {
    // El ancla se lee ahora: el actualizador de estado puede ejecutarse más
    // tarde, cuando `anchor.current` ya apunta a este mismo archivo.
    const from = files.findIndex((f) => f.id === anchor.current);
    setChecked((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && from !== -1) {
        const [a, b] = from < index ? [from, index] : [index, from];
        files.slice(a, b + 1).forEach((f) => next.add(f.id));
      } else if (next.has(file.id)) {
        next.delete(file.id);
      } else {
        next.add(file.id);
      }
      return next;
    });
    anchor.current = file.id;
  };

  const onRowClick = (event: MouseEvent, file: DriveFile, index: number) => {
    setSelected(file.id);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      toggle(file, index, event);
    } else {
      anchor.current = file.id;
    }
  };

  const clearChecked = () => {
    setChecked(new Set());
    anchor.current = null;
  };

  const openTransfer = (items: DriveFile[]) =>
    transferIntent.open({
      accountId,
      items: items.filter((f) => !f.trashed),
      onQueued: () => setChecked((prev) => (items.some((i) => prev.has(i.id)) ? new Set() : prev)),
    });

  /** Lo que arrastra o transfiere una fila: toda la selección si forma parte de ella. */
  const itemsFor = (file: DriveFile) => (checked.has(file.id) ? checkedFiles : [file]);

  const open = useCallback(
    (file: DriveFile) => {
      if (file.isFolder) {
        setFilter('');
        setSelected(null);
        navigate(`/drive/${accountId}/${file.id}`);
      } else if (file.webViewLink) {
        window.open(file.webViewLink, '_blank', 'noopener,noreferrer');
      }
    },
    [accountId, navigate],
  );

  const download = (file: DriveFile) => {
    const promise = downloadFile(accountId, file.id, file.name);
    toast.promise(promise, {
      loading: `Descargando «${file.name}»…`,
      success: 'Descarga completada',
      error: (e: Error) => e.message,
    });
  };

  const trash = (file: DriveFile, trashed: boolean) =>
    update.mutate(
      { fileId: file.id, trashed },
      {
        onSuccess: () =>
          toast.success(trashed ? `«${file.name}» a la papelera` : `«${file.name}» restaurado`, {
            action: trashed ? { label: 'Deshacer', onClick: () => update.mutate({ fileId: file.id, trashed: false }) } : undefined,
          }),
      },
    );

  const actionsFor = (file: DriveFile): MenuItem[] => [
    ...(file.isFolder ? [{ label: 'Abrir', icon: <FolderOpen />, onSelect: () => open(file) }] : []),
    ...(!file.isFolder ? [{ label: 'Descargar', icon: <ArrowDownToLine />, onSelect: () => download(file) }] : []),
    ...(file.webViewLink
      ? [{ label: 'Abrir en Google Drive', icon: <ExternalLink />, onSelect: () => window.open(file.webViewLink!, '_blank', 'noopener,noreferrer') }]
      : []),
    { label: 'Renombrar', icon: <Pencil />, onSelect: () => setRenaming(file), separatorBefore: true },
    { label: 'Mover a…', icon: <FolderInput />, onSelect: () => setMoving(file) },
    ...(!file.trashed ? [{ label: 'Transferir a otra cuenta', icon: <ArrowLeftRight />, onSelect: () => openTransfer(itemsFor(file)) }] : []),
    file.trashed
      ? { label: 'Restaurar', icon: <RotateCcw />, onSelect: () => trash(file, false), separatorBefore: true }
      : { label: 'Enviar a la papelera', icon: <Trash2 />, onSelect: () => trash(file, true), separatorBefore: true },
    { label: 'Eliminar para siempre', icon: <Trash2 />, danger: true, onSelect: () => setDeleting(file) },
  ];

  // Teclado sobre la lista: flechas para moverse, Enter abre, F2 renombra,
  // Supr manda a la papelera. Mismos atajos que un explorador de escritorio.
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = files.findIndex((f) => f.id === selected);
    const focusRow = (i: number) => {
      const file = files[Math.max(0, Math.min(files.length - 1, i))];
      if (!file) return;
      setSelected(file.id);
      document.getElementById(`row-${file.id}`)?.focus();
    };
    const current = files[index];
    const step = view === 'grid' ? Math.max(1, Math.floor((event.currentTarget.clientWidth || 1) / 200)) : 1;
    switch (event.key) {
      case 'ArrowDown':
        focusRow(index + step);
        break;
      case 'ArrowUp':
        focusRow(index - step);
        break;
      case 'ArrowRight':
        if (view === 'grid') focusRow(index + 1);
        else return;
        break;
      case 'ArrowLeft':
        if (view === 'grid') focusRow(index - 1);
        else return;
        break;
      case 'Enter':
        if (current) open(current);
        break;
      case ' ':
        if (current) toggle(current, index, event);
        break;
      case 'a':
      case 'A':
        if (!(event.metaKey || event.ctrlKey)) return;
        setChecked(new Set(files.map((f) => f.id)));
        break;
      case 'Escape':
        if (checked.size === 0) return;
        clearChecked();
        break;
      case 't':
      case 'T':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (checkedFiles.length) openTransfer(checkedFiles);
        else if (current) openTransfer([current]);
        break;
      case 'F2':
        if (current) setRenaming(current);
        break;
      case 'Delete':
        if (current) trash(current, !current.trashed);
        break;
      case 'Backspace':
        if (crumbs.data && folderId !== 'root') navigate(`/drive/${accountId}/${crumbs.data.at(-2)?.id ?? ''}`.replace(/\/$/, ''));
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length) uploads.enqueue(accountId, folderId, event.dataTransfer.files);
  };

  if (accounts.isSuccess && !account) {
    return (
      <EmptyState icon={<TriangleAlert className="size-6" />} title="Esa cuenta no está vinculada" action={<Link to="/" className="text-sm font-medium text-accent">Volver al resumen</Link>}>
        Puede que se desvinculara desde otra sesión.
      </EmptyState>
    );
  }

  const reauthNeeded = account?.needsReauth || (folder.error instanceof ApiError && folder.error.needsReauth);
  const color = accountColor(accountId);

  return (
    <div
      className="relative min-h-full"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Franja con el color de capa de la cuenta: orienta sin leer nada. */}
      <div className="h-1" style={{ background: color }} aria-hidden />

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8">
        <header className="mb-5 flex flex-wrap items-center gap-4 animate-rise">
          {account && <AccountAvatar account={account} size={40} />}
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-2xl font-bold tracking-[-0.03em]">{account ? accountLabel(account) : <span className="skeleton inline-block h-7 w-48" />}</h1>
            {account?.alias && <p className="truncate font-mono text-xs text-faint">{account.email}</p>}
          </div>
          {quota.data && (
            <div className="w-full sm:w-80">
              <div className="mb-1.5 flex items-center justify-between gap-2 font-mono text-xs tabular">
                <span>{formatBytes(quota.data.usage)} usados</span>
                {quota.data.usageInDriveTrash > 0 && (
                  <button
                    type="button"
                    onClick={() => setConfirmEmptyTrash(true)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[11px] text-muted transition-colors hover:bg-sunken hover:text-danger"
                  >
                    <Trash2 className="size-3" /> Vaciar papelera
                  </button>
                )}
                <span className="text-faint">{quota.data.limit ? formatPercent(quota.data.usedPercent) : '∞'}</span>
              </div>
              <QuotaBreakdown quota={quota.data} color={color} compact />
            </div>
          )}
        </header>

        {/* Migas de pan */}
        <nav aria-label="Ruta" className="mb-4 flex min-h-8 items-center gap-1 overflow-x-auto text-sm">
          <Link to={`/drive/${accountId}`} className={cn('shrink-0 rounded-md px-2 py-1 hover:bg-sunken', folderId === 'root' ? 'font-medium text-ink' : 'text-muted')}>
            Mi unidad
          </Link>
          {folderId !== 'root' && crumbs.isPending && (
            <>
              <ChevronRight className="size-3.5 shrink-0 text-faint" />
              <span className="skeleton h-4 w-24" />
            </>
          )}
          {crumbs.data?.map((crumb, index) => (
            <span key={crumb.id} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="size-3.5 text-faint" />
              <Link
                to={`/drive/${accountId}/${crumb.id}`}
                aria-current={index === crumbs.data.length - 1 ? 'page' : undefined}
                className={cn('rounded-md px-2 py-1 hover:bg-sunken', index === crumbs.data.length - 1 ? 'font-medium text-ink' : 'text-muted')}
              >
                {crumb.name}
              </Link>
            </span>
          ))}
        </nav>

        {/* Barra de herramientas */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" icon={<Upload className="size-3.5" />} onClick={() => fileInput.current?.click()} disabled={reauthNeeded}>
            Subir
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) uploads.enqueue(accountId, folderId, e.target.files);
              e.target.value = '';
            }}
          />
          <Button size="sm" icon={<FolderPlus className="size-3.5" />} onClick={() => setNewFolderOpen(true)} disabled={reauthNeeded}>
            Carpeta
          </Button>

          <div className="relative ml-auto w-full sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar esta carpeta" aria-label="Filtrar esta carpeta" className={cn(inputClass, 'h-8 w-full pl-8 text-[13px]')} />
            {filter && (
              <button onClick={() => setFilter('')} className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-ink" aria-label="Limpiar filtro">
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              writePref('stackdrive.sort', e.target.value);
            }}
            aria-label="Ordenar por"
            className={cn(inputClass, 'h-8 pr-8 text-[13px]')}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>

          <label className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] text-muted hover:bg-sunken">
            <input type="checkbox" checked={showTrashed} onChange={(e) => setShowTrashed(e.target.checked)} className="accent-[var(--accent)]" />
            Papelera
          </label>

          <div className="flex rounded-lg border border-line bg-raised p-0.5" role="group" aria-label="Vista">
            {(['list', 'grid'] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  setView(v);
                  writePref('stackdrive.view', v);
                }}
                aria-pressed={view === v}
                aria-label={v === 'list' ? 'Lista' : 'Cuadrícula'}
                className={cn('grid size-7 place-items-center rounded-md transition-colors', view === v ? 'bg-sunken text-ink' : 'text-faint hover:text-ink')}
              >
                {v === 'list' ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
              </button>
            ))}
          </div>
        </div>

        {/* Contenido */}
        {reauthNeeded ? (
          <div className="card">
            <EmptyState icon={<TriangleAlert className="size-6" />} title="Esta cuenta necesita volver a autorizarse" action={<Link to="/accounts"><Button variant="primary">Ir a cuentas</Button></Link>}>
              Google revocó el acceso de StackDrive (cambio de contraseña, revocación manual o inactividad).
            </EmptyState>
          </div>
        ) : folder.isError && !folder.data ? (
          <div className="card">
            <EmptyState icon={<TriangleAlert className="size-6" />} title="No se pudo abrir la carpeta" action={<Button onClick={() => void folder.refetch()}>Reintentar</Button>}>
              {folder.error.message}
            </EmptyState>
          </div>
        ) : folder.isPending ? (
          <ListSkeleton />
        ) : files.length === 0 ? (
          <div className="card border-dashed">
            <EmptyState
              icon={filter ? <Search className="size-6" /> : <CloudUpload className="size-6" />}
              title={filter ? 'Nada coincide con el filtro' : 'Carpeta vacía'}
              action={!filter && <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()}>Subir archivos</Button>}
            >
              {filter ? `No hay elementos con «${filter}» aquí.` : 'Arrastra archivos a cualquier parte de esta pantalla o usa el botón.'}
            </EmptyState>
          </div>
        ) : view === 'list' ? (
          <div className={cn('card overflow-hidden transition-opacity', folder.isPlaceholderData && 'opacity-60')}>
            <div role="grid" aria-label="Archivos" aria-rowcount={files.length} onKeyDown={onListKeyDown}>
              <div role="row" className="grid grid-cols-[1fr_auto] gap-4 border-b border-line bg-sunken/40 px-4 py-2 font-mono text-[11px] tracking-wide text-faint uppercase sm:grid-cols-[1fr_7rem_9rem_2.5rem]">
                <span role="columnheader" className="flex items-center gap-3">
                  <SelectBox
                    label="Seleccionar todo"
                    checked={checked.size > 0 && files.every((f) => checked.has(f.id))}
                    indeterminate={checked.size > 0 && !files.every((f) => checked.has(f.id))}
                    onChange={(value) => setChecked(value ? new Set(files.map((f) => f.id)) : new Set())}
                    visible
                  />
                  Nombre
                </span>
                <span role="columnheader" className="hidden text-right sm:block">Tamaño</span>
                <span role="columnheader" className="hidden sm:block">Modificado</span>
                <span role="columnheader" className="sr-only">Acciones</span>
              </div>
              {files.map((file, index) => (
                <div
                  key={file.id}
                  id={`row-${file.id}`}
                  role="row"
                  tabIndex={selected === file.id || (!selected && index === 0) ? 0 : -1}
                  aria-selected={selected === file.id || checked.has(file.id)}
                  onClick={(e) => onRowClick(e, file, index)}
                  onDoubleClick={() => open(file)}
                  onFocus={() => setSelected(file.id)}
                  draggable={!file.trashed}
                  onDragStart={(e) => startItemsDrag(e, accountId, itemsFor(file))}
                  className={cn(
                    'group grid cursor-default grid-cols-[1fr_auto] items-center gap-4 border-b border-line px-4 py-2 outline-none select-none last:border-b-0 sm:grid-cols-[1fr_7rem_9rem_2.5rem]',
                    'transition-colors hover:bg-sunken/40',
                    selected === file.id && 'bg-accent-soft/50 hover:bg-accent-soft/60',
                    checked.has(file.id) && 'bg-accent-soft/70 hover:bg-accent-soft/80',
                    file.trashed && 'opacity-60',
                  )}
                >
                  <span role="gridcell" className="flex min-w-0 items-center gap-3">
                    <SelectBox
                      label={`Seleccionar ${file.name}`}
                      checked={checked.has(file.id)}
                      onChange={() => toggle(file, index, { shiftKey: false })}
                      onShiftClick={() => toggle(file, index, { shiftKey: true })}
                      visible={checked.size > 0}
                    />
                    <FileIcon file={file} />
                    <button
                      tabIndex={-1}
                      onClick={(e) => {
                        if (file.isFolder) {
                          e.stopPropagation();
                          open(file);
                        }
                      }}
                      className={cn('truncate text-left text-sm', file.isFolder && 'font-medium hover:underline underline-offset-4')}
                    >
                      {file.name}
                    </button>
                    {file.trashed && <Badge tone="danger">Papelera</Badge>}
                  </span>
                  <span role="gridcell" className="hidden text-right font-mono text-xs text-muted tabular sm:block">{file.isFolder ? '—' : formatBytes(file.size)}</span>
                  <span role="gridcell" className="hidden text-xs text-muted sm:block">{formatRelative(file.modifiedTime)}</span>
                  <span role="gridcell" className="flex justify-end">
                    <RowMenu file={file} items={actionsFor(file)} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            role="grid"
            aria-label="Archivos"
            onKeyDown={onListKeyDown}
            className={cn('grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 transition-opacity', folder.isPlaceholderData && 'opacity-60')}
          >
            {files.map((file, index) => (
              <div
                key={file.id}
                id={`row-${file.id}`}
                role="gridcell"
                tabIndex={selected === file.id || (!selected && index === 0) ? 0 : -1}
                aria-selected={selected === file.id || checked.has(file.id)}
                onClick={(e) => onRowClick(e, file, index)}
                onDoubleClick={() => open(file)}
                onFocus={() => setSelected(file.id)}
                draggable={!file.trashed}
                onDragStart={(e) => startItemsDrag(e, accountId, itemsFor(file))}
                className={cn(
                  'card group relative flex cursor-default flex-col overflow-hidden outline-none select-none transition-[border-color,transform] hover:-translate-y-0.5 hover:border-line-strong animate-rise',
                  selected === file.id && 'border-accent ring-3 ring-accent/15',
                  checked.has(file.id) && 'border-accent bg-accent-soft/40 ring-3 ring-accent/25',
                  file.trashed && 'opacity-60',
                )}
                style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
              >
                <span className="absolute top-2 left-2 z-10 rounded-md bg-canvas/85 p-1 backdrop-blur">
                  <SelectBox
                    label={`Seleccionar ${file.name}`}
                    checked={checked.has(file.id)}
                    onChange={() => toggle(file, index, { shiftKey: false })}
                    onShiftClick={() => toggle(file, index, { shiftKey: true })}
                    visible={checked.size > 0}
                  />
                </span>
                <Thumb file={file} />
                <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
                  <FileIcon file={file} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={file.name}>{file.name}</span>
                  <RowMenu file={file} items={actionsFor(file)} />
                </div>
              </div>
            ))}
          </div>
        )}

        {folder.data && files.length > 0 && (
          <p className="mt-4 text-center font-mono text-[11px] text-faint">
            {files.length} elemento{files.length === 1 ? '' : 's'}
            {folder.data.nextPageToken && ' · se muestran los primeros 500'}
            {' · '}doble clic o Enter para abrir · Mayús/Ctrl+clic seleccionar · T transferir · arrastra a otra cuenta de la barra lateral
          </p>
        )}
      </div>

      {/* Superposición de arrastrar y soltar */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-canvas/70 backdrop-blur-sm animate-fade">
          <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed px-16 py-12" style={{ borderColor: color, background: `${color}14` }}>
            <CloudUpload className="size-10" style={{ color }} />
            <p className="font-display text-xl font-semibold">Suelta para subir</p>
            <p className="text-sm text-muted">a {crumbs.data?.at(-1)?.name ?? 'Mi unidad'} · {account ? accountLabel(account) : ''}</p>
          </div>
        </div>
      )}

      <NewFolderDialog accountId={accountId} parentId={folderId} open={newFolderOpen} onClose={() => setNewFolderOpen(false)} />
      <RenameDialog accountId={accountId} file={renaming} onClose={() => setRenaming(null)} />
      <MoveDialog accountId={accountId} file={moving} onClose={() => setMoving(null)} />
      {checkedFiles.length > 0 && (
        <SelectionBar
          files={checkedFiles}
          onClear={clearChecked}
          onTransfer={() => openTransfer(checkedFiles)}
          onDownload={() => checkedFiles.filter((f) => !f.isFolder).forEach(download)}
          onTrash={() => {
            const targets = checkedFiles.filter((f) => !f.trashed);
            void Promise.allSettled(targets.map((f) => update.mutateAsync({ fileId: f.id, trashed: true }))).then((results) => {
              const ok = targets.filter((_, i) => results[i]!.status === 'fulfilled');
              toast.success(`${ok.length} elemento${ok.length === 1 ? '' : 's'} a la papelera`, {
                action: { label: 'Deshacer', onClick: () => ok.forEach((f) => update.mutate({ fileId: f.id, trashed: false })) },
              });
              if (ok.length < targets.length) toast.error(`${targets.length - ok.length} no se pudieron enviar a la papelera`);
            });
            clearChecked();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="¿Eliminar para siempre?"
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success(`«${deleting.name}» eliminado`);
              setDeleting(null);
            },
          })
        }
      >
        «<strong className="text-ink">{deleting?.name}</strong>» se borrará sin pasar por la papelera. {deleting?.isFolder && 'Incluye todo su contenido. '}No se puede deshacer.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmEmptyTrash}
        onClose={() => setConfirmEmptyTrash(false)}
        title="¿Vaciar la papelera?"
        confirmLabel="Vaciar papelera"
        danger
        loading={emptyTrash.isPending}
        onConfirm={() =>
          emptyTrash.mutate(undefined, {
            onSuccess: ({ freedBytes }) => {
              toast.success(`Papelera vaciada: ${formatBytes(freedBytes)} liberados`, {
                description: 'Google puede tardar unos minutos en reflejarlo en la cuota.',
              });
              setConfirmEmptyTrash(false);
            },
            onError: (error) => toast.error(error.message),
          })
        }
      >
        Se borrará para siempre todo lo que hay en la papelera de <strong className="text-ink">{account ? accountLabel(account) : 'esta cuenta'}</strong>
        {quota.data && <> ({formatBytes(quota.data.usageInDriveTrash)})</>}, también lo que no movió StackDrive. No se puede deshacer.
      </ConfirmDialog>
    </div>
  );
}

function RowMenu({ file, items }: { file: DriveFile; items: MenuItem[] }) {
  return (
    <Menu
      label={`Acciones de ${file.name}`}
      items={items}
      trigger={(props) => (
        <button
          {...props}
          tabIndex={-1}
          aria-label={`Acciones de ${file.name}`}
          className="grid size-7 place-items-center rounded-md text-faint opacity-60 transition hover:bg-sunken hover:text-ink group-hover:opacity-100 aria-expanded:opacity-100 group-aria-selected:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </button>
      )}
    />
  );
}

/** Miniatura de Google si la hay; si falla o no existe, icono grande del tipo. */
function Thumb({ file }: { file: DriveFile }) {
  const [broken, setBroken] = useState(false);
  const kind = fileKind(file);
  return (
    <div className="relative grid aspect-[4/3] place-items-center overflow-hidden" style={{ background: `${kind.color}12` }}>
      {file.thumbnailLink && !broken ? (
        <img src={file.thumbnailLink} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="size-full object-cover" />
      ) : (
        <FileIcon file={file} className="size-12" />
      )}
      {!file.isFolder && file.size !== null && (
        <span className="absolute right-2 bottom-2 rounded-md bg-canvas/85 px-1.5 py-0.5 font-mono text-[10px] text-muted backdrop-blur">{formatBytes(file.size)}</span>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="card overflow-hidden" aria-busy aria-label="Cargando archivos">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
          <span className="skeleton size-5" />
          <span className="skeleton h-3.5" style={{ width: `${30 + ((i * 37) % 40)}%` }} />
          <span className="skeleton ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * Casilla de selección. Oculta hasta pasar el ratón por la fila (o mientras
 * haya algo seleccionado) para no ensuciar la lista; siempre visible en
 * pantallas táctiles, donde no hay hover.
 */
function SelectBox({ label, checked, indeterminate, onChange, onShiftClick, visible }: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  onShiftClick?: () => void;
  visible?: boolean;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      tabIndex={-1}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate;
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey && onShiftClick) {
          e.preventDefault();
          onShiftClick();
        }
      }}
      onChange={(e) => onChange(e.target.checked)}
      className={cn(
        'size-4 shrink-0 cursor-pointer accent-[var(--accent)] transition-opacity',
        !checked && !indeterminate && !visible && 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100',
      )}
    />
  );
}

function SelectionBar({ files, onClear, onTransfer, onDownload, onTrash }: {
  files: DriveFile[];
  onClear: () => void;
  onTransfer: () => void;
  onDownload: () => void;
  onTrash: () => void;
}) {
  const folders = files.filter((f) => f.isFolder).length;
  const bytes = files.reduce((sum, f) => sum + (f.isFolder ? 0 : (f.size ?? 0)), 0);
  const downloadable = files.length - folders;

  return (
    <div
      role="toolbar"
      aria-label="Acciones sobre la selección"
      className="fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-line-strong bg-raised p-1.5 pl-4 shadow-[var(--shadow)] animate-rise lg:left-[calc(50%+8rem)]"
    >
      <p className="mr-2 text-sm whitespace-nowrap">
        <span className="font-medium">{files.length} seleccionado{files.length === 1 ? '' : 's'}</span>
        <span className="hidden font-mono text-xs text-faint sm:inline">
          {' · '}
          {formatBytes(bytes)}
          {folders > 0 && ` + ${folders} carpeta${folders === 1 ? '' : 's'}`}
        </span>
      </p>
      <Button size="sm" variant="primary" icon={<ArrowLeftRight className="size-3.5" />} onClick={onTransfer}>
        Transferir
      </Button>
      {downloadable > 0 && (
        <Button size="sm" variant="ghost" icon={<ArrowDownToLine className="size-3.5" />} onClick={onDownload} title={folders ? 'Las carpetas no se descargan' : undefined}>
          <span className="hidden sm:inline">Descargar</span>
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onTrash}>
        <span className="hidden sm:inline">Papelera</span>
      </Button>
      <button onClick={onClear} aria-label="Quitar selección" title="Quitar selección (Esc)" className="grid size-8 place-items-center rounded-lg text-faint hover:bg-sunken hover:text-ink">
        <X className="size-4" />
      </button>
    </div>
  );
}
