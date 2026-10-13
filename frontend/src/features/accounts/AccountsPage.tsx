import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, Pencil, Plus, RefreshCw, Unlink } from 'lucide-react';
import { keys, useAccounts, useLinkAccount, useReauthAccount, useRenameAccount, useUnlinkAccount } from '../../api/hooks';
import type { GoogleAccount } from '../../api/types';
import { accountLabel } from '../../lib/account-color';
import { formatDate, formatRelative } from '../../lib/format';
import { Page } from '../../components/ui/Page';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { AccountAvatar } from '../../components/ui/AccountAvatar';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'Cancelaste el consentimiento en Google.',
  missing_code_or_state: 'Google no devolvió los datos esperados.',
};

/** URL a la que Google debe devolver al usuario: esta misma pantalla. */
const returnUrl = () => `${window.location.origin}/accounts`;

export function AccountsPage() {
  const accounts = useAccounts();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [linkOpen, setLinkOpen] = useState(params.get('link') === '1');
  const [renaming, setRenaming] = useState<GoogleAccount | null>(null);
  const [unlinking, setUnlinking] = useState<GoogleAccount | null>(null);
  const reauth = useReauthAccount();
  const unlink = useUnlinkAccount();

  // Vuelta del consentimiento de Google: el callback de la API deja el
  // resultado en la query string. Se consume una vez y se limpia la URL.
  useEffect(() => {
    const status = params.get('status');
    if (params.get('link') === '1') setLinkOpen(true);
    if (!status && !params.has('link')) return;
    if (status === 'linked') {
      toast.success(params.get('relinked') === 'true' ? 'Cuenta reautorizada' : 'Cuenta vinculada', { description: params.get('email') ?? undefined });
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
      void queryClient.invalidateQueries({ queryKey: keys.quotaAll });
    } else if (status === 'error') {
      const reason = params.get('reason') ?? '';
      toast.error('La vinculación no se completó', { description: OAUTH_ERRORS[reason] ?? reason });
    }
    setParams({}, { replace: true });
  }, [params, setParams, queryClient]);

  const list = accounts.data?.filter((a) => a.status !== 'REVOKED') ?? [];

  return (
    <Page
      eyebrow="Cuentas"
      title="Cuentas vinculadas"
      description="Cada cuenta de Google es una capa de tu pila. Los permisos se pueden revocar desde aquí o desde la propia cuenta de Google."
      actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setLinkOpen(true)}>Vincular cuenta</Button>}
    >
      <div className="card overflow-hidden">
        {accounts.isPending ? (
          <ul className="divide-y divide-line">
            {Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="flex items-center gap-4 p-5">
                <span className="skeleton size-10 rounded-full" />
                <span className="skeleton h-4 w-56" />
              </li>
            ))}
          </ul>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Plus className="size-6" />}
            title="Sin cuentas todavía"
            action={<Button variant="primary" onClick={() => setLinkOpen(true)}>Vincular la primera</Button>}
          >
            Al vincular, Google te pedirá permiso para que StackDrive gestione los archivos de esa cuenta.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((account, i) => (
              <li key={account.id} className="flex flex-wrap items-center gap-4 p-5 animate-rise" style={{ animationDelay: `${i * 40}ms` }}>
                <AccountAvatar account={account} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">{accountLabel(account)}</p>
                    {account.status === 'ACTIVE' ? <Badge tone="ok" dot>Activa</Badge> : <Badge tone="warn" dot>Necesita reautorizar</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted">
                    {account.alias && <span className="font-mono text-xs">{account.email} · </span>}
                    Vinculada {formatDate(account.linkedAt)} · último uso {formatRelative(account.lastUsedAt)}
                  </p>
                  {account.statusError && <p className="mt-1 text-xs text-warn">{account.statusError}</p>}
                </div>
                <div className="flex items-center gap-1.5">
                  {account.needsReauth && (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<RefreshCw className="size-3.5" />}
                      loading={reauth.isPending && reauth.variables?.accountId === account.id}
                      onClick={() =>
                        reauth.mutate(
                          { accountId: account.id, redirectTo: returnUrl() },
                          { onSuccess: ({ authUrl }) => window.location.assign(authUrl) },
                        )
                      }
                    >
                      Reautorizar
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setRenaming(account)}>
                    Alias
                  </Button>
                  <Button size="sm" variant="ghost" className="hover:!text-danger" icon={<Unlink className="size-3.5" />} onClick={() => setUnlinking(account)}>
                    Desvincular
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <LinkDialog open={linkOpen} onClose={() => setLinkOpen(false)} />
      <RenameDialog account={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={!!unlinking}
        onClose={() => setUnlinking(null)}
        title={`¿Desvincular ${unlinking ? accountLabel(unlinking) : ''}?`}
        confirmLabel="Desvincular"
        danger
        loading={unlink.isPending}
        onConfirm={() =>
          unlinking &&
          unlink.mutate(unlinking.id, {
            onSuccess: () => {
              toast.success('Cuenta desvinculada');
              setUnlinking(null);
            },
          })
        }
      >
        StackDrive revocará su acceso en Google. Tus archivos <strong className="text-ink">no se borran</strong>: siguen en esa cuenta de Google.
      </ConfirmDialog>
    </Page>
  );
}

function LinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const link = useLinkAccount();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    link.mutate(
      {
        alias: String(data.get('alias')).trim() || undefined,
        loginHint: String(data.get('loginHint')).trim() || undefined,
        redirectTo: returnUrl(),
      },
      // Misma pestaña: la API devuelve aquí con ?status=… al terminar, sin
      // tener que sondear la lista de cuentas desde otra ventana.
      { onSuccess: ({ authUrl }) => window.location.assign(authUrl) },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Vincular cuenta de Google"
      description="Te llevaremos a Google para que autorices el acceso a Drive y volverás aquí al terminar."
    >
      <form id="link-form" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Alias (opcional)" name="alias" placeholder="Trabajo, Fotos 2019…" maxLength={80} autoFocus />
        <Field label="Email sugerido (opcional)" name="loginHint" type="email" placeholder="tu.cuenta@gmail.com" hint="Preselecciona la cuenta en el selector de Google." />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={link.isPending} icon={<ExternalLink className="size-4" />}>
            Continuar en Google
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ account, onClose }: { account: GoogleAccount | null; onClose: () => void }) {
  const rename = useRenameAccount();
  return (
    <Dialog open={!!account} onClose={onClose} title="Cambiar alias" description={account?.email}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const alias = String(new FormData(event.currentTarget).get('alias')).trim();
          if (!account || !alias) return;
          rename.mutate({ accountId: account.id, alias });
          onClose();
        }}
      >
        <Field label="Alias" name="alias" defaultValue={account?.alias ?? ''} required maxLength={80} autoFocus />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary">Guardar</Button>
        </div>
      </form>
    </Dialog>
  );
}
