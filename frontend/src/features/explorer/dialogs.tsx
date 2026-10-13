import { useState } from 'react';
import { toast } from 'sonner';
import { useCreateFolder, useUpdateFile } from '../../api/hooks';
import type { DriveFile } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { FolderPicker } from './FolderPicker';
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
