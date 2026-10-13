import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ArrowRight, Info, TriangleAlert } from 'lucide-react';
import { useAccounts, useAggregateQuota, useEnqueueBatch, useEnqueueTransfer, useTransferPreview } from '../../api/hooks';
import type { ConflictMode, DriveFile } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { FolderPicker } from '../explorer/FolderPicker';
import { FileIcon, isGoogleNative } from '../explorer/file-icon';
import type { Crumb } from '../explorer/use-breadcrumbs';
import { transferIntent, useTransferIntent } from './transfer-intent';

const ROOT: Crumb = { id: 'root', name: 'Mi unidad' };

/**
 * Diálogo único de transferencia entre cuentas: un archivo, varios, o
 * carpetas completas. Se monta una vez en el shell y lo abre cualquiera a
 * través de `transferIntent`.
 */
export function TransferDialog() {
  const intent = useTransferIntent();
  // `key` reinicia todo el estado interno con cada apertura.
  return intent ? <TransferDialogBody key={intentKey(intent.accountId, intent.items)} /> : null;
}

function intentKey(accountId: string, items: DriveFile[]) {
  return `${accountId}:${items.map((i) => i.id).join(',')}`;
}

function TransferDialogBody() {
  const intent = useTransferIntent();
  const accounts = useAccounts();
  const quota = useAggregateQuota();
  const enqueueFile = useEnqueueTransfer();
  const enqueueBatch = useEnqueueBatch();
  const navigate = useNavigate();

  const accountId = intent?.accountId ?? '';
  const items = useMemo(() => intent?.items ?? [], [intent]);
  const [targetId, setTargetId] = useState<string | null>(intent?.targetId ?? null);
  const [folder, setFolder] = useState<Crumb>(ROOT);
  // Un único archivo usa la ruta de siempre (progreso por bytes de ese
  // archivo); cualquier otra cosa es un lote, que sabe recorrer carpetas.
  const single = items.length === 1 && !items[0]!.isFolder ? items[0]! : null;
  const singleNative = single ? isGoogleNative(single.mimeType) : false;

  // Mover por defecto: quien pulsa «Transferir» espera que el elemento pase a
  // la otra cuenta. Es seguro porque el original solo se borra tras verificar.
  const [deleteSource, setDeleteSource] = useState(!singleNative);
  const [permanent, setPermanent] = useState(false);
  const [onConflict, setOnConflict] = useState<ConflictMode>('merge');
  const hasFolders = items.some((i) => i.isFolder);
  const knownBytes = items.reduce((sum, i) => sum + (i.isFolder ? 0 : (i.size ?? 0)), 0);

  const candidates = accounts.data?.filter((a) => a.status === 'ACTIVE' && a.id !== accountId) ?? [];
  const selected = targetId ?? quota.data?.recommendedAccountId ?? candidates[0]?.id ?? null;
  const target = candidates.some((a) => a.id === selected) ? selected : (candidates[0]?.id ?? null);

  const preview = useTransferPreview(
    single || !target ? null : { fromAccountId: accountId, toAccountId: target, parentId: folder.id, ids: items.map((i) => i.id) },
  );
  const summary = preview.data;
  const conflicts = summary?.conflicts ?? [];
  const blocked = !!summary && !summary.fits;

  // Al cambiar de cuenta destino, la carpeta elegida pertenecía a la otra.
  useEffect(() => setFolder(ROOT), [target]);

  const close = () => transferIntent.close();
  const moving = deleteSource && !singleNative;
  const pending = enqueueFile.isPending || enqueueBatch.isPending;
  const label = items.length === 1 ? items[0]!.name : `${items.length} elementos`;

  const submit = () => {
    if (!target) return;
    const parentId = folder.id === 'root' ? undefined : folder.id;
    const onSuccess = () => {
      toast.success(`${moving ? 'Movimiento' : 'Copia'} de «${label}» en cola`, {
        action: { label: 'Ver', onClick: () => navigate('/transfers') },
      });
      intent?.onQueued?.();
      close();
    };
    const onError = (error: Error) => toast.error(error.message);

    if (single) {
      enqueueFile.mutate(
        {
          from: { accountId, fileId: single.id },
          to: { accountId: target, parentId },
          deleteSource: moving,
          permanentlyDeleteSource: moving && permanent,
          fileName: single.name,
        },
        { onSuccess, onError },
      );
    } else {
      enqueueBatch.mutate(
        {
          fromAccountId: accountId,
          toAccountId: target,
          parentId,
          items: items.map((i) => ({ id: i.id })),
          deleteSource: moving,
          permanentlyDeleteSource: moving && permanent,
          onConflict,
          label,
        },
        { onSuccess, onError },
      );
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      className="w-[min(94vw,580px)]"
      title={items.length === 1 ? 'Transferir a otra cuenta' : `Transferir ${items.length} elementos`}
      description={
        hasFolders
          ? 'Se recrea la estructura de carpetas en el destino. Cada archivo se copia y se verifica; si lo pides, solo entonces se borra el original.'
          : 'Se copia, se verifica la copia (md5 o tamaño) y solo entonces, si lo pides, se borra el original.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancelar</Button>
          <Button variant="primary" disabled={!target || blocked || (!single && preview.isPending)} loading={pending} onClick={submit}>
            {moving ? 'Mover' : 'Copiar'}
            {items.length > 1 && ` ${items.length}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <SelectionSummary items={items} />

        {!singleNative && candidates.length > 0 && (
          <ModePicker moving={deleteSource} hasFolders={hasFolders} onChange={setDeleteSource} />
        )}

        {candidates.length === 0 ? (
          <p className="text-sm text-muted">
            Necesitas otra cuenta activa. <Link className="text-accent underline-offset-4 hover:underline" to="/accounts?link=1" onClick={close}>Vincula una</Link>.
          </p>
        ) : (
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-muted">Cuenta de destino</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {candidates.map((account) => {
                const q = quota.data?.results.find((r) => r.account.id === account.id);
                const fits = q?.freeBytes === null || q?.freeBytes === undefined || knownBytes <= q.freeBytes;
                const checked = account.id === target;
                return (
                  <label
                    key={account.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors',
                      checked ? 'border-accent bg-accent-soft/40 ring-3 ring-accent/10' : 'border-line hover:border-line-strong',
                      !fits && 'opacity-50',
                    )}
                  >
                    <input type="radio" name="target" className="sr-only" checked={checked} disabled={!fits} onChange={() => setTargetId(account.id)} />
                    <span className="size-3 rounded-[3px]" style={{ background: accountColor(account.id) }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{accountLabel(account)}</span>
                      <span className="block font-mono text-[11px] text-faint">
                        {q ? (fits ? `${formatBytes(q.freeBytes)} libres` : 'Sin espacio suficiente') : '…'}
                      </span>
                    </span>
                    {account.id === quota.data?.recommendedAccountId && <span className="text-[11px] font-medium text-accent">Recomendada</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {target && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-muted">
              Carpeta de destino <ArrowRight className="size-3" /> <span className="text-ink">{folder.name}</span>
            </p>
            <FolderPicker key={target} accountId={target} onChange={setFolder} />
          </div>
        )}

        {!single && target && <PreviewPanel loading={preview.isPending} error={preview.error} summary={summary} moving={moving} />}

        {conflicts.length > 0 && (
          <fieldset className="rounded-xl border border-warn/40 bg-warn-soft/40 px-3.5 py-3">
            <legend className="sr-only">Conflicto de nombres</legend>
            <p className="mb-2 text-[13px]">
              {conflicts.length === 1 ? <>Ya existe «<strong>{conflicts[0]!.name}</strong>» en {folder.name}.</> : <>{conflicts.length} carpetas ya existen en {folder.name}.</>}
            </p>
            <div className="flex flex-col gap-1.5 text-sm">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="radio" name="conflict" checked={onConflict === 'merge'} onChange={() => setOnConflict('merge')} className="mt-0.5 accent-[var(--accent)]" />
                <span>
                  Combinar
                  <span className="block text-xs text-muted">Se añade a la carpeta existente; lo que ya esté idéntico no se vuelve a subir.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="radio" name="conflict" checked={onConflict === 'rename'} onChange={() => setOnConflict('rename')} className="mt-0.5 accent-[var(--accent)]" />
                <span>
                  Crear una carpeta nueva
                  <span className="block text-xs text-muted">Por ejemplo «{conflicts[0]!.name} (2)».</span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        {singleNative ? (
          <p className="flex gap-2 rounded-xl bg-sunken/50 px-3.5 py-3 text-[13px] text-muted">
            <Info className="mt-0.5 size-4 shrink-0" />
            Los documentos nativos de Google solo se pueden copiar: la copia es una conversión de formato y no se puede verificar byte a byte, así que el original nunca se borra.
          </p>
        ) : (
          deleteSource && (
            <label className="flex cursor-pointer items-start gap-3 text-sm animate-fade">
              <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} className="mt-0.5 size-4 accent-[var(--danger)]" />
              <span>
                Liberar el espacio al instante
                <span className="block text-[13px] text-muted">Los originales se borran para siempre en vez de ir a la papelera, que sigue ocupando cuota. Solo ocurre si la copia se verifica.</span>
              </span>
            </label>
          )
        )}
      </div>
    </Dialog>
  );
}

function ModePicker({ moving, hasFolders, onChange }: {
  moving: boolean;
  hasFolders: boolean;
  onChange: (moving: boolean) => void;
}) {
  const options = [
    {
      value: true,
      title: 'Mover',
      hint: hasFolders
        ? 'Pasa a la otra cuenta. Cada original va a la papelera tras verificar su copia; la carpeta de origen, solo si queda vacía.'
        : 'Pasa a la otra cuenta. El original va a la papelera tras verificar la copia.',
    },
    { value: false, title: 'Copiar', hint: 'Queda en las dos cuentas. El origen no se toca.' },
  ];
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium text-muted">Qué hacer</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const checked = option.value === moving;
          return (
            <label
              key={option.title}
              className={cn(
                'flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3.5 py-3 transition-colors',
                checked ? 'border-accent bg-accent-soft/40 ring-3 ring-accent/10' : 'border-line hover:border-line-strong',
              )}
            >
              <input type="radio" name="mode" className="sr-only" checked={checked} onChange={() => onChange(option.value)} />
              <span className="text-sm font-medium">{option.title}</span>
              <span className="text-xs text-muted">{option.hint}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function SelectionSummary({ items }: { items: DriveFile[] }) {
  if (items.length === 1) {
    const item = items[0]!;
    return (
      <div className="flex items-center gap-3 rounded-xl bg-sunken/50 px-3.5 py-3">
        <FileIcon file={item} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
        <span className="font-mono text-xs text-faint">{item.isFolder ? 'carpeta' : formatBytes(item.size)}</span>
      </div>
    );
  }
  const shown = items.slice(0, 4);
  return (
    <ul className="rounded-xl bg-sunken/50 px-3.5 py-2.5">
      {shown.map((item) => (
        <li key={item.id} className="flex items-center gap-3 py-1">
          <FileIcon file={item} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px]">{item.name}</span>
          <span className="font-mono text-[11px] text-faint">{item.isFolder ? 'carpeta' : formatBytes(item.size)}</span>
        </li>
      ))}
      {items.length > shown.length && <li className="py-1 text-xs text-muted">y {items.length - shown.length} más</li>}
    </ul>
  );
}

function PreviewPanel({ loading, error, summary, moving }: {
  loading: boolean;
  error: Error | null;
  summary: ReturnType<typeof useTransferPreview>['data'];
  moving: boolean;
}) {
  if (error) {
    return <p className="rounded-xl bg-danger-soft/60 px-3.5 py-3 text-[13px] text-danger">No se pudo analizar la selección: {error.message}</p>;
  }
  if (loading || !summary) {
    return (
      <div className="rounded-xl border border-line px-3.5 py-3" aria-busy>
        <p className="text-[13px] text-muted">Analizando carpetas…</p>
        <div className="skeleton mt-2 h-3 w-2/3" />
      </div>
    );
  }

  const notes = [
    summary.nativeDocs > 0 && `${summary.nativeDocs} documento${summary.nativeDocs === 1 ? '' : 's'} de Google: se copia${summary.nativeDocs === 1 ? '' : 'n'} convertido${summary.nativeDocs === 1 ? '' : 's'}${moving ? ' y el original se conserva' : ''}`,
    summary.shortcuts > 0 && `${summary.shortcuts} acceso${summary.shortcuts === 1 ? '' : 's'} directo${summary.shortcuts === 1 ? '' : 's'}: se salta${summary.shortcuts === 1 ? '' : 'n'}`,
    moving && summary.notOwned > 0 && `${summary.notOwned} de otros propietarios: se salta${summary.notOwned === 1 ? '' : 'n'} al mover`,
    summary.notExportable > 0 && `${summary.notExportable} sin formato exportable (Formularios, Sites…): se salta${summary.notExportable === 1 ? '' : 'n'}`,
  ].filter(Boolean) as string[];

  return (
    <div className={cn('rounded-xl border px-3.5 py-3', summary.fits ? 'border-line' : 'border-danger/50 bg-danger-soft/40')}>
      <p className="font-mono text-[13px] tabular">
        {summary.truncated && 'Más de '}
        {summary.files} archivo{summary.files === 1 ? '' : 's'}
        {summary.folders > 0 && ` · ${summary.folders} carpeta${summary.folders === 1 ? '' : 's'}`}
        {' · '}
        {formatBytes(summary.bytes)}
      </p>
      {notes.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
          {notes.map((note) => <li key={note}>· {note}</li>)}
        </ul>
      )}
      {summary.truncated && <p className="mt-1.5 text-xs text-muted">La carpeta es muy grande: el recuento se detuvo en {summary.files} archivos, pero se transferirá entera.</p>}
      {!summary.fits && (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-danger">
          <TriangleAlert className="size-4 shrink-0" />
          No cabe: hacen falta {formatBytes(summary.bytes)} y hay {formatBytes(summary.targetFreeBytes)} libres.
        </p>
      )}
    </div>
  );
}
