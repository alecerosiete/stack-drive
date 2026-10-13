import { ArrowLeftRight, ArrowRight, Check, CircleAlert, Clock, ShieldCheck } from 'lucide-react';
import { useAccounts, useTransfers, isActiveJob, transferName } from '../../api/hooks';
import type { TransferJob } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { formatBytes, formatDuration, formatRelative } from '../../lib/format';
import { Page } from '../../components/ui/Page';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';

const STATE_LABEL: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' }> = {
  completed: { label: 'Completada', tone: 'ok' },
  failed: { label: 'Fallida', tone: 'danger' },
  active: { label: 'En curso', tone: 'accent' },
  waiting: { label: 'En cola', tone: 'neutral' },
  delayed: { label: 'Reintentando', tone: 'warn' },
  prioritized: { label: 'En cola', tone: 'neutral' },
};

export function TransfersPage() {
  const transfers = useTransfers();
  const jobs = transfers.data ?? [];
  const running = jobs.filter(isActiveJob);
  const finished = jobs.filter((j) => !isActiveJob(j));

  return (
    <Page
      eyebrow="Transferencias"
      title="Entre cuentas"
      description="Copias y movimientos en segundo plano. Se actualiza solo: rápido mientras hay algo en marcha."
    >
      {transfers.isPending ? (
        <div className="grid gap-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="card skeleton h-20" />)}</div>
      ) : jobs.length === 0 ? (
        <div className="card">
          <EmptyState icon={<ArrowLeftRight className="size-6" />} title="Sin transferencias recientes">
            Usa «Transferir a otra cuenta» desde el menú de cualquier archivo, o ejecuta un plan de redistribución.
          </EmptyState>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {running.length > 0 && <Section title="En marcha" jobs={running} />}
          {finished.length > 0 && <Section title="Recientes" jobs={finished} />}
        </div>
      )}
    </Page>
  );
}

function Section({ title, jobs }: { title: string; jobs: TransferJob[] }) {
  return (
    <section>
      <h2 className="mb-3 font-mono text-[11px] tracking-[0.14em] text-faint uppercase">{title} · {jobs.length}</h2>
      <ul className="card divide-y divide-line overflow-hidden">
        {jobs.map((job) => <JobRow key={job.jobId} job={job} />)}
      </ul>
    </section>
  );
}

function JobRow({ job }: { job: TransferJob }) {
  const accounts = useAccounts();
  const find = (id?: string) => accounts.data?.find((a) => a.id === id);
  const from = job.result?.source.account ?? find(job.request?.from.accountId);
  const to = job.result?.uploaded.account ?? find(job.request?.to.accountId);
  const friendly = job.result?.source.name ?? transferName(job.jobId);
  const name = friendly ?? job.request?.from.fileId ?? `Job ${job.jobId}`;
  const state = STATE_LABEL[job.state] ?? { label: job.state, tone: 'neutral' as const };
  const active = isActiveJob(job);

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn('grid size-8 place-items-center rounded-lg', job.state === 'completed' ? 'bg-ok-soft text-ok' : job.state === 'failed' ? 'bg-danger-soft text-danger' : 'bg-sunken text-muted')}>
          {job.state === 'completed' ? <Check className="size-4" /> : job.state === 'failed' ? <CircleAlert className="size-4" /> : <Clock className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', !friendly && 'font-mono text-xs')}>{name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {from && <><span className="size-2 rounded-[2px]" style={{ background: accountColor(from.id) }} />{accountLabel(from)}</>}
            {from && to && <ArrowRight className="size-3 text-faint" />}
            {to && <><span className="size-2 rounded-[2px]" style={{ background: accountColor(to.id) }} />{accountLabel(to)}</>}
            <span className="text-faint">· {formatRelative(job.finishedAt ?? job.createdAt)}</span>
          </p>
        </div>
        <Badge tone={state.tone} dot={active}>{state.label}</Badge>
      </div>

      {active && (
        <div className="mt-3 ml-11 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500 animate-stripes"
              style={{ width: `${Math.max(job.progress, 3)}%`, backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 8px, rgb(255 255 255 / 0.25) 8px 16px)' }}
            />
          </div>
          <span className="w-10 text-right font-mono text-xs tabular">{job.progress} %</span>
        </div>
      )}

      {job.result && (
        <p className="mt-2 ml-11 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-mono">{formatBytes(job.result.source.size)}</span>
          <span className="flex items-center gap-1">
            <ShieldCheck className={cn('size-3.5', job.result.verified ? 'text-ok' : 'text-warn')} />
            {job.result.verification === 'none' ? 'Sin verificación (documento nativo)' : `Verificada por ${job.result.verification}`}
          </span>
          <span>{job.result.sourceDeleted ? 'Original eliminado' : job.result.sourceTrashed ? 'Original a la papelera' : 'Original conservado'}</span>
          <span className="font-mono">{formatDuration(job.result.durationMs)}</span>
        </p>
      )}
      {job.error && <p className="mt-2 ml-11 text-xs text-danger">{job.error}{job.attemptsMade > 1 && ` (tras ${job.attemptsMade} intentos)`}</p>}
    </li>
  );
}
