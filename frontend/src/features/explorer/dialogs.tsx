import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ArrowRight, Info } from 'lucide-react';
import { useAccounts, useAggregateQuota, useCreateFolder, useEnqueueTransfer, useUpdateFile } from '../../api/hooks';
import type { DriveFile } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { FolderPicker } from './FolderPicker';
import { FileIcon, isGoogleNative } from './file-icon';
import type { Crumb } from './use-breadcrumbs';

export function NewFolderDialog({ accountId, parentId, open, onClose }: {
  accountId: string;
  parentId: string;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateFolder(accountId);
  return (
    <Dialog open={open} onClose={onClose} title="Nueva carpeta">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get('name')).trim();
          if (!name) return;
          create.mutate({ name, parentId }, { onSuccess: () => { toast.success(`Carpeta «${name}» creada`); onClose(); } });
        }}
      >
        <Field label="Nombre" name="name" required maxLength={255} autoFocus defaultValue="Nueva carpeta" onFocus={(e) => e.currentTarget.select()} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Crear</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RenameDialog({ accountId, file, onClose }: { accountId: string; file: DriveFile | null; onClose: () => void }) {
  const update = useUpdateFile(accountId);
  return (
    <Dialog open={!!file} onClose={onClose} title="Renombrar">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get('name')).trim();
          if (!file || !name || name === file.name) return onClose();
          update.mutate({ fileId: file.id, name });
          onClose();
        }}
      >
        <Field
          label="Nombre"
          name="name"
          required
          maxLength={255}
          autoFocus
          defaultValue={file?.name}
          // Selecciona el nombre sin la extensión, como hacen los exploradores nativos.
          onFocus={(e) => {
            const dot = file && !file.isFolder ? file.name.lastIndexOf('.') : -1;
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary">Guardar</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function MoveDialog({ accountId, file, onClose }: { accountId: string; file: DriveFile | null; onClose: () => void }) {
  const update = useUpdateFile(accountId);
  const [target, setTarget] = useState<Crumb>({ id: 'root', name: 'Mi unidad' });
  const alreadyThere = !!file && (file.parents.includes(target.id) || (target.id === 'root' && file.parents.length === 0));

  return (
    <Dialog
      open={!!file}
      onClose={onClose}
      title={`Mover «${file?.name ?? ''}»`}
      description="Dentro de esta misma cuenta. Para llevarlo a otra cuenta usa «Transferir»."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={alreadyThere}
            onClick={() => {
              if (!file) return;
              update.mutate(
                { fileId: file.id, parentId: target.id },
                { onSuccess: () => toast.success(`«${file.name}» movido a ${target.name}`) },
              );
              onClose();
            }}
          >
            Mover aquí
          </Button>
        </>
      }
    >
      {file && <FolderPicker key={file.id} accountId={accountId} onChange={setTarget} disabledIds={[file.id]} />}
    </Dialog>
  );
}

export function TransferDialog({ accountId, file, onClose }: { accountId: string; file: DriveFile | null; onClose: () => void }) {
  const accounts = useAccounts();
  const quota = useAggregateQuota();
  const enqueue = useEnqueueTransfer();
  const navigate = useNavigate();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [folder, setFolder] = useState<Crumb>({ id: 'root', name: 'Mi unidad' });
  const [deleteSource, setDeleteSource] = useState(false);

  const native = file ? isGoogleNative(file.mimeType) : false;
  const candidates = accounts.data?.filter((a) => a.status === 'ACTIVE' && a.id !== accountId) ?? [];
  const selected = targetId ?? quota.data?.recommendedAccountId ?? candidates[0]?.id ?? null;
  const effectiveTarget = candidates.some((a) => a.id === selected) ? selected : (candidates[0]?.id ?? null);

  const close = () => {
    setTargetId(null);
    setDeleteSource(false);
    setFolder({ id: 'root', name: 'Mi unidad' });
    onClose();
  };

  return (
    <Dialog
      open={!!file}
      onClose={close}
      className="w-[min(94vw,560px)]"
      title="Transferir a otra cuenta"
      description="Se copia, se verifica la copia (md5 o tamaño) y solo entonces, si lo pides, el original va a la papelera."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={!effectiveTarget}
            loading={enqueue.isPending}
            onClick={() => {
              if (!file || !effectiveTarget) return;
              enqueue.mutate(
                {
                  from: { accountId, fileId: file.id },
                  to: { accountId: effectiveTarget, parentId: folder.id === 'root' ? undefined : folder.id },
                  deleteSource: deleteSource && !native,
                  fileName: file.name,
                },
                {
                  onSuccess: () => {
                    toast.success(`Transferencia de «${file.name}» en cola`, {
                      action: { label: 'Ver', onClick: () => navigate('/transfers') },
                    });
                    close();
                  },
                },
              );
            }}
          >
            {deleteSource && !native ? 'Mover' : 'Copiar'}
          </Button>
        </>
      }
    >
      {file && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3 rounded-xl bg-sunken/50 px-3.5 py-3">
            <FileIcon file={file} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
            <span className="font-mono text-xs text-faint">{formatBytes(file.size)}</span>
          </div>

          {candidates.length === 0 ? (
            <p className="text-sm text-muted">
              Necesitas otra cuenta activa. <Link className="text-accent underline-offset-4 hover:underline" to="/accounts?link=1">Vincula una</Link>.
            </p>
          ) : (
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-muted">Cuenta de destino</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {candidates.map((account) => {
                  const q = quota.data?.results.find((r) => r.account.id === account.id);
                  const fits = q?.freeBytes === null || q?.freeBytes === undefined || (file.size ?? 0) <= q.freeBytes;
                  const checked = account.id === effectiveTarget;
                  return (
                    <label
                      key={account.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors',
                        checked ? 'border-accent bg-accent-soft/40 ring-3 ring-accent/10' : 'border-line hover:border-line-strong',
                        !fits && 'opacity-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="target"
                        className="sr-only"
                        checked={checked}
                        disabled={!fits}
                        onChange={() => {
                          setTargetId(account.id);
                          setFolder({ id: 'root', name: 'Mi unidad' });
                        }}
                      />
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

          {effectiveTarget && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-muted">
                Carpeta de destino <ArrowRight className="size-3" /> <span className="text-ink">{folder.name}</span>
              </p>
              <FolderPicker key={effectiveTarget} accountId={effectiveTarget} onChange={setFolder} />
            </div>
          )}

          {native ? (
            <p className="flex gap-2 rounded-xl bg-sunken/50 px-3.5 py-3 text-[13px] text-muted">
              <Info className="mt-0.5 size-4 shrink-0" />
              Los documentos nativos de Google solo se pueden copiar: la copia es una conversión de formato y no se puede verificar byte a byte, así que el original nunca se borra.
            </p>
          ) : (
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
              <span>
                Mover en lugar de copiar
                <span className="block text-[13px] text-muted">El original irá a la papelera de la cuenta de origen tras verificar la copia.</span>
              </span>
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}
