import { Link } from 'react-router';
import { ArrowRight, ArrowUpRight, Plus, Scale, Sparkles, TriangleAlert } from 'lucide-react';
import { useAccounts, useAggregateQuota } from '../../api/hooks';
import { accountColor, accountLabel } from '../../lib/account-color';
import { formatBytes, formatPercent } from '../../lib/format';
import { Page, FailureList } from '../../components/ui/Page';
import { StackMeter, QuotaBar } from '../../components/ui/StackMeter';
import { AccountAvatar } from '../../components/ui/AccountAvatar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';

export function DashboardPage() {
  const accounts = useAccounts();
  const quota = useAggregateQuota();

  const reauth = accounts.data?.filter((a) => a.needsReauth) ?? [];
  const active = accounts.data?.filter((a) => a.status === 'ACTIVE') ?? [];

  if (accounts.isSuccess && accounts.data.filter((a) => a.status !== 'REVOKED').length === 0) {
    return (
      <Page eyebrow="Resumen" title="Tu pila está vacía">
        <div className="card">
          <EmptyState
            icon={<Plus className="size-6" />}
            title="Vincula tu primera cuenta de Google"
            action={
              <Link to="/accounts?link=1">
                <Button variant="primary" icon={<Plus className="size-4" />}>Vincular cuenta</Button>
              </Link>
            }
          >
            Cada cuenta aporta sus 15 GB gratuitos a la pila. Puedes vincular tantas como quieras.
          </EmptyState>
        </div>
      </Page>
    );
  }

  const totals = quota.data?.totals;
  const usedPercent = totals?.limit ? (totals.usage / totals.limit) * 100 : null;
  const recommended = quota.data?.results.find((q) => q.account.id === quota.data?.recommendedAccountId);
  const pressured = quota.data?.results.filter((q) => (q.usedPercent ?? 0) >= 85) ?? [];

  return (
    <Page eyebrow="Resumen" title="Tu pila de almacenamiento">
      {reauth.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 animate-rise">
          <TriangleAlert className="size-4 text-warn" />
          <p className="flex-1 text-sm">
            <strong className="font-medium">{reauth.map((a) => a.email).join(', ')}</strong>{' '}
            {reauth.length === 1 ? 'perdió el acceso' : 'perdieron el acceso'} y no aparece{reauth.length === 1 ? '' : 'n'} en los totales.
          </p>
          <Link to="/accounts" className="text-sm font-medium text-warn underline-offset-4 hover:underline">Reautorizar</Link>
        </div>
      )}
      {quota.data && <FailureList failures={quota.data.failures} />}

      {/* Bloque principal: cifra grande + barra apilada. */}
      <section className="card relative overflow-hidden p-6 sm:p-8 animate-rise" style={{ animationDelay: '60ms' }}>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm text-muted">Espacio libre en {active.length} cuenta{active.length === 1 ? '' : 's'}</p>
            {quota.isPending ? (
              <div className="skeleton mt-2 h-16 w-64" />
            ) : (
              <p className="mt-1 font-display text-6xl font-bold tracking-[-0.05em] tabular sm:text-7xl">
                {totals?.freeBytes !== null && totals?.freeBytes !== undefined ? formatBytes(totals.freeBytes) : '∞'}
              </p>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-10 gap-y-1 text-sm">
            <dt className="text-faint">Usado</dt>
            <dd className="text-right font-mono tabular">{formatBytes(totals?.usage)}</dd>
            <dt className="text-faint">Capacidad</dt>
            <dd className="text-right font-mono tabular">{totals?.limit ? formatBytes(totals.limit) : 'Ilimitada'}</dd>
            <dt className="text-faint">Ocupación</dt>
            <dd className="text-right font-mono tabular">{formatPercent(usedPercent)}</dd>
          </dl>
        </div>
        <StackMeter className="mt-8" quotas={quota.data?.results ?? []} height={52} />
      </section>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {recommended && (
          <section className="card flex items-start gap-4 p-5 animate-rise" style={{ animationDelay: '120ms' }}>
            <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
              <Sparkles className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-medium">Siguiente subida: {accountLabel(recommended.account)}</h2>
              <p className="mt-0.5 text-sm text-muted">Es la cuenta con más hueco ({formatBytes(recommended.freeBytes)} libres).</p>
            </div>
            <Link to={`/drive/${recommended.account.id}`} aria-label="Abrir cuenta recomendada" className="rounded-lg p-2 text-faint hover:bg-sunken hover:text-ink">
              <ArrowRight className="size-4" />
            </Link>
          </section>
        )}
        <section className="card flex items-start gap-4 p-5 animate-rise" style={{ animationDelay: '160ms' }}>
          <span className={`grid size-10 place-items-center rounded-xl ${pressured.length ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`}>
            <Scale className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">{pressured.length ? `${pressured.length} cuenta${pressured.length === 1 ? '' : 's'} casi llena${pressured.length === 1 ? '' : 's'}` : 'Cuota equilibrada'}</h2>
            <p className="mt-0.5 text-sm text-muted">
              {pressured.length ? 'Revisa un plan de redistribución; nada se mueve sin tu confirmación.' : 'Ninguna cuenta supera el 85 % de su capacidad.'}
            </p>
          </div>
          <Link to="/rebalance" aria-label="Ver plan de redistribución" className="rounded-lg p-2 text-faint hover:bg-sunken hover:text-ink">
            <ArrowRight className="size-4" />
          </Link>
        </section>
      </div>

      <h2 className="mt-10 mb-4 font-display text-xl font-semibold tracking-tight">Cuentas</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(accounts.isPending ? Array.from({ length: 3 }, () => null) : accounts.data?.filter((a) => a.status !== 'REVOKED') ?? []).map((account, i) => {
          if (!account) return <li key={i} className="card h-36 skeleton" />;
          const q = quota.data?.results.find((r) => r.account.id === account.id);
          return (
            <li key={account.id} className="animate-rise" style={{ animationDelay: `${200 + i * 50}ms` }}>
              <Link
                to={account.needsReauth ? '/accounts' : `/drive/${account.id}`}
                className="card group flex h-full flex-col gap-4 p-5 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong"
              >
                <div className="flex items-center gap-3">
                  <AccountAvatar account={account} size={34} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{accountLabel(account)}</p>
                    {account.alias && <p className="truncate font-mono text-xs text-faint">{account.email}</p>}
                  </div>
                  <ArrowUpRight className="size-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                {account.needsReauth ? (
                  <Badge tone="warn" dot>Necesita reautorizar</Badge>
                ) : q ? (
                  <div className="mt-auto">
                    <div className="mb-2 flex justify-between font-mono text-xs tabular">
                      <span>{formatBytes(q.usage)}</span>
                      <span className="text-faint">{formatPercent(q.usedPercent)}</span>
                    </div>
                    <QuotaBar percent={q.usedPercent} color={accountColor(account.id)} />
                  </div>
                ) : (
                  <div className="skeleton mt-auto h-6" />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}
