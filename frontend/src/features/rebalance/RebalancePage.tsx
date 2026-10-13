import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ArrowRight, Check, CircleCheck, Play, Scale } from 'lucide-react';
import { useEnqueueTransfer, useRebalancePlan } from '../../api/hooks';
import type { PlannedMove } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { formatBytes, formatPercent } from '../../lib/format';
import { Page, FailureList } from '../../components/ui/Page';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { QuotaBar } from '../../components/ui/StackMeter';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { FileIcon } from '../explorer/file-icon';

const moveKey = (m: PlannedMove) => `${m.from.id}:${m.file.id}`;

/**
 * El plan solo propone: cada movimiento se ejecuta únicamente cuando el
 * usuario lo confirma, uno a uno o en bloque (invariante del backend).
 */
export function RebalancePage() {
  const [threshold, setThreshold] = useState(85);
  const [applied, setApplied] = useState<number | null>(null);
  const plan = useRebalancePlan(applied === null ? null : applied / 100);
  const enqueue = useEnqueueTransfer();
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);

  const run = async (moves: PlannedMove[]) => {
    for (const move of moves) {
      try {
        await enqueue.mutateAsync({ from: { accountId: move.from.id, fileId: move.file.id }, to: { accountId: move.to.id }, deleteSource: true, fileName: move.file.name });
        setQueued((prev) => new Set(prev).add(moveKey(move)));
      } catch (error) {
        toast.error(`«${move.file.name}»: ${(error as Error).message}`);
      }
    }
  };

  const pending = plan.data?.moves.filter((m) => !queued.has(moveKey(m))) ?? [];

  return (
    <Page
      eyebrow="Redistribuir"
      title="Equilibrar la pila"
      description="Propuesta para bajar las cuentas más llenas por debajo del umbral, moviendo archivos a las que tienen hueco. Nada se mueve hasta que tú lo confirmas."
    >
      <section className="card mb-6 flex flex-wrap items-center gap-6 p-5 animate-rise">
        <label className="flex min-w-64 flex-1 flex-col gap-2">
          <span className="flex justify-between text-sm">
            <span className="text-muted">Umbral de presión</span>
            <span className="font-mono font-medium tabular">{threshold} %</span>
          </span>
          <input
            type="range"
            min={50}
            max={99}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            onPointerUp={() => setApplied(threshold)}
            onKeyUp={() => setApplied(threshold)}
            className="accent-[var(--accent)]"
          />
        </label>
        {plan.data && (
          <dl className="flex gap-8 text-sm">
            <div>
              <dt className="text-faint">Liberaría</dt>
              <dd className="font-display text-2xl font-bold tracking-tight tabular">{formatBytes(plan.data.freedBytes)}</dd>
            </div>
            <div>
              <dt className="text-faint">Sin resolver</dt>
              <dd className={cn('font-display text-2xl font-bold tracking-tight tabular', plan.data.unresolvedBytes > 0 && 'text-warn')}>{formatBytes(plan.data.unresolvedBytes)}</dd>
            </div>
          </dl>
        )}
      </section>

      {plan.data && <FailureList failures={plan.data.failures} />}

      {plan.isPending ? (
        <div className="grid gap-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="card skeleton h-20" />)}</div>
      ) : plan.isError ? (
        <div className="card"><EmptyState icon={<Scale className="size-6" />} title="No se pudo calcular el plan">{plan.error.message}</EmptyState></div>
      ) : plan.data && (
        <>
          {plan.data.underPressure.length > 0 && (
            <section className="mb-6 grid gap-3 sm:grid-cols-2">
              {plan.data.underPressure.map((p) => (
                <div key={p.account.id} className="card p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm">
                    <span className="size-2.5 rounded-[3px]" style={{ background: accountColor(p.account.id) }} />
                    <span className="flex-1 truncate font-medium">{accountLabel(p.account)}</span>
                    <span className="font-mono text-xs text-danger tabular">{formatPercent(p.usedPercent)}</span>
                  </div>
                  <QuotaBar percent={p.usedPercent} />
                  <p className="mt-2 text-xs text-muted">Hay que liberar {formatBytes(p.bytesToFree)}</p>
                </div>
              ))}
            </section>
          )}

          {plan.data.notes.length > 0 && (
            <ul className="mb-6 space-y-1 text-sm text-muted">
              {plan.data.notes.map((note) => <li key={note}>· {note}</li>)}
            </ul>
          )}

          {plan.data.moves.length === 0 ? (
            <div className="card">
              <EmptyState icon={<CircleCheck className="size-6" />} title="Nada que mover">
                Todas las cuentas están por debajo del {Math.round(plan.data.threshold * 100)} % o no hay destino con hueco suficiente.
              </EmptyState>
            </div>
          ) : (
            <section className="card overflow-hidden">
              <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
                <h2 className="flex-1 font-medium">{plan.data.moves.length} movimiento{plan.data.moves.length === 1 ? '' : 's'} propuesto{plan.data.moves.length === 1 ? '' : 's'}</h2>
                {queued.size > 0 && <Link to="/transfers" className="text-sm text-accent underline-offset-4 hover:underline">Ver {queued.size} en cola</Link>}
                <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} disabled={pending.length === 0} onClick={() => setConfirmAll(true)}>
                  Ejecutar todos
                </Button>
              </header>
              <ul className="divide-y divide-line">
                {plan.data.moves.map((move, i) => {
                  const done = queued.has(moveKey(move));
                  return (
                    <li key={moveKey(move)} className="grid items-center gap-3 px-5 py-3 sm:grid-cols-[1fr_auto_auto] animate-rise" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                      <div className="flex min-w-0 items-center gap-3">
                        <FileIcon file={move.file} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{move.file.name}</span>
                          <span className="font-mono text-xs text-faint">{formatBytes(move.bytes)}</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <AccountPill account={move.from} />
                        <ArrowRight className="size-3.5 text-faint" />
                        <AccountPill account={move.to} />
                      </div>
                      <Button
                        size="sm"
                        variant={done ? 'ghost' : 'secondary'}
                        disabled={done}
                        loading={enqueue.isPending && enqueue.variables?.from.fileId === move.file.id}
                        icon={done ? <Check className="size-3.5 text-ok" /> : undefined}
                        onClick={() => void run([move])}
                      >
                        {done ? 'En cola' : 'Mover'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title={`¿Mover ${pending.length} archivo${pending.length === 1 ? '' : 's'}?`}
        confirmLabel="Ejecutar"
        loading={enqueue.isPending}
        onConfirm={() => {
          void run(pending).then(() => {
            setConfirmAll(false);
            toast.success('Movimientos en cola', { description: 'Cada copia se verifica antes de enviar el original a la papelera.' });
          });
        }}
      >
        Cada archivo se copia a la cuenta destino, se verifica la copia y solo entonces el original va a la papelera de la cuenta de origen. Recuerda que la papelera sigue ocupando cuota hasta que la vacíes.
      </ConfirmDialog>
    </Page>
  );
}

function AccountPill({ account }: { account: { id: string; email: string; alias: string | null } }) {
  return (
    <span className="flex max-w-40 items-center gap-1.5 rounded-full bg-sunken px-2 py-1">
      <span className="size-2 shrink-0 rounded-[2px]" style={{ background: accountColor(account.id) }} />
      <span className="truncate">{accountLabel(account)}</span>
    </span>
  );
}
