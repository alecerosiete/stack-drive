import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ArrowLeftRight, ArrowRight, Check, ChevronDown, CircleAlert, Clock, FolderSync, RotateCcw, ShieldCheck } from 'lucide-react';
import { useAccounts, useEnqueueBatch, useTransfers, isActiveJob, transferName } from '../../api/hooks';
import type { BatchItemStatus, BatchProgress, BatchTransferJob, FileTransferJob, TransferJob } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { formatBytes, formatDuration, formatRelative } from '../../lib/format';
import { Page } from '../../components/ui/Page';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Button } from '../../components/ui/Button';

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
            Usa «Transferir a otra cuenta» desde el menú de cualquier archivo o carpeta, arrastra elementos a otra cuenta de la barra lateral, o ejecuta un plan de redistribución.
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
  return job.kind === 'batch' ? <BatchJobRow job={job} /> : <FileJobRow job={job} />;
}

type AccountLike = { id: string; email: string; alias: string | null };

function RowHeader({ job, name, mono, from, to, icon }: {
  job: TransferJob;
  name: string;
  mono?: boolean;
  from?: AccountLike;
  to?: AccountLike;
  icon?: ReactNode;
}) {
  const state = STATE_LABEL[job.state] ?? { label: job.state, tone: 'neutral' as const };
  const failedItems = job.kind === 'batch' ? (job.result?.counts.failed ?? 0) : 0;
  const finalState = job.state === 'completed' && failedItems > 0 ? { label: 'Con errores', tone: 'warn' as const } : state;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        className={cn(
          'grid size-8 place-items-center rounded-lg',
          finalState.tone === 'ok' ? 'bg-ok-soft text-ok' : finalState.tone === 'danger' ? 'bg-danger-soft text-danger' : finalState.tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-sunken text-muted',
        )}
      >
        {icon ?? (finalState.tone === 'ok' ? <Check className="size-4" /> : finalState.tone === 'danger' || finalState.tone === 'warn' ? <CircleAlert className="size-4" /> : <Clock className="size-4" />)}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-medium', mono && 'font-mono text-xs')}>{name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {from && <><span className="size-2 rounded-[2px]" style={{ background: accountColor(from.id) }} />{accountLabel(from)}</>}
          {from && to && <ArrowRight className="size-3 text-faint" />}
          {to && <><span className="size-2 rounded-[2px]" style={{ background: accountColor(to.id) }} />{accountLabel(to)}</>}
          <span className="text-faint">· {formatRelative(job.finishedAt ?? job.createdAt)}</span>
        </p>
      </div>
      <Badge tone={finalState.tone} dot={isActiveJob(job)}>{finalState.label}</Badge>
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 animate-stripes"
          style={{ width: `${Math.max(percent, 3)}%`, backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 8px, rgb(255 255 255 / 0.25) 8px 16px)' }}
        />
      </div>
      <span className="w-10 text-right font-mono text-xs tabular">{percent} %</span>
    </div>
  );
}

function JobError({ job }: { job: TransferJob }) {
  if (!job.error) return null;
  return <p className="mt-2 ml-11 text-xs text-danger">{job.error}{job.attemptsMade > 1 && ` (tras ${job.attemptsMade} intentos)`}</p>;
}

function FileJobRow({ job }: { job: FileTransferJob }) {
  const accounts = useAccounts();
  const find = (id?: string) => accounts.data?.find((a) => a.id === id);
  const from = job.result?.source.account ?? find(job.request?.from.accountId);
  const to = job.result?.uploaded.account ?? find(job.request?.to.accountId);
  const friendly = job.result?.source.name ?? transferName(job.jobId);
  const name = friendly ?? job.request?.from.fileId ?? `Job ${job.jobId}`;

  return (
    <li className="px-5 py-4">
      <RowHeader job={job} name={name} mono={!friendly} from={from} to={to} />
      {isActiveJob(job) && <div className="mt-3 ml-11"><ProgressBar percent={job.progress} /></div>}
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
      <JobError job={job} />
    </li>
  );
}

const PHASE_LABEL: Record<BatchProgress['phase'], string> = {
  scanning: 'Analizando carpetas…',
  folders: 'Creando la estructura en el destino…',
  transferring: 'Transfiriendo',
  cleaning: 'Limpiando el origen…',
};

const STATUS_META: Record<BatchItemStatus, { label: string; className: string }> = {
  moved: { label: 'movido', className: 'text-ok' },
  copied: { label: 'copiado', className: 'text-ok' },
  already: { label: 'ya estaba', className: 'text-muted' },
  skipped: { label: 'saltado', className: 'text-muted' },
  failed: { label: 'fallido', className: 'text-danger' },
};

function BatchJobRow({ job }: { job: BatchTransferJob }) {
  const accounts = useAccounts();
  const retry = useEnqueueBatch();
  const [expanded, setExpanded] = useState(false);
  const find = (id?: string) => accounts.data?.find((a) => a.id === id);
  const from = job.result?.from ?? find(job.batch?.fromAccountId);
  const to = job.result?.to ?? find(job.batch?.toAccountId);
  const name = job.batch?.label ?? `${job.batch?.items.length ?? '?'} elementos`;
  const detail = job.detail;
  const result = job.result;
  const failed = result?.items.filter((i) => i.status === 'failed') ?? [];

  const retryFailed = () => {
    if (!job.batch || failed.length === 0) return;
    retry.mutate(
      {
        fromAccountId: job.batch.fromAccountId,
        toAccountId: job.batch.toAccountId,
        // Cada archivo vuelve a la subcarpeta que le tocaba, ya creada.
        items: failed.map((i) => ({ id: i.fileId, parentId: i.targetParentId })),
        deleteSource: job.batch.deleteSource,
        permanentlyDeleteSource: job.batch.permanentlyDeleteSource,
        onConflict: 'merge',
        label: `${name} · reintento (${failed.length})`,
      },
      {
        onSuccess: () => toast.success(`Reintentando ${failed.length} archivo${failed.length === 1 ? '' : 's'}`),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <li className="px-5 py-4">
      <RowHeader job={job} name={name} from={from} to={to} icon={isActiveJob(job) ? <FolderSync className="size-4" /> : undefined} />

      {isActiveJob(job) && (
        <div className="mt-3 ml-11">
          <ProgressBar percent={job.progress} />
          <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted">
            <span>{detail ? PHASE_LABEL[detail.phase] : 'En cola'}</span>
            {detail && detail.filesTotal > 0 && (
              <span className="font-mono tabular">
                {detail.filesDone}/{detail.filesTotal} archivos · {formatBytes(detail.bytesDone)} / {formatBytes(detail.bytesTotal)}
              </span>
            )}
            {detail?.current && detail.phase === 'transferring' && <span className="min-w-0 truncate text-faint">{detail.current}</span>}
          </p>
        </div>
      )}

      {result && (
        <div className="mt-2 ml-11">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {(Object.keys(STATUS_META) as BatchItemStatus[])
              .filter((status) => result.counts[status] > 0)
              .map((status) => (
                <span key={status} className={STATUS_META[status].className}>
                  {result.counts[status]} {STATUS_META[status].label}{result.counts[status] === 1 || status === 'already' ? '' : 's'}
                </span>
              ))}
            <span className="font-mono">{formatBytes(result.bytesTransferred)}</span>
            <span className="font-mono">{formatDuration(result.durationMs)}</span>
          </p>
          {result.removedSourceFolders.map((folder) => (
            <p key={folder} className="mt-1 text-xs text-muted">Carpeta «{folder}» eliminada del origen</p>
          ))}
          {result.keptSourceFolders.map((folder) => (
            <p key={folder.name} className="mt-1 text-xs text-warn">«{folder.name}» se conserva en el origen: {folder.reason}</p>
          ))}

          <div className="mt-2 flex flex-wrap gap-2">
            {result.items.length > 0 && (
              <Button size="sm" variant="ghost" icon={<ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />} onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
                {expanded ? 'Ocultar detalle' : `Ver ${result.items.length} archivo${result.items.length === 1 ? '' : 's'}`}
              </Button>
            )}
            {failed.length > 0 && (
              <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={retry.isPending} onClick={retryFailed}>
                Reintentar fallidos ({failed.length})
              </Button>
            )}
          </div>

          {expanded && (
            <ul className="mt-2 max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line text-xs animate-fade">
              {result.items.map((item) => (
                <li key={item.fileId} className="flex items-start gap-3 px-3 py-2">
                  <span className={cn('w-16 shrink-0 font-medium', STATUS_META[item.status].className)}>{STATUS_META[item.status].label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={item.path}>{item.path}</span>
                    {item.reason && <span className="block text-faint">{item.reason}</span>}
                  </span>
                  <span className="shrink-0 font-mono text-faint">{formatBytes(item.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <JobError job={job} />
    </li>
  );
}
