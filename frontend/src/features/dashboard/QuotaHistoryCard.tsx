import { useEffect, useRef, useState } from 'react';
import { LineChart } from 'lucide-react';
import { useQuotaHistory } from '../../api/hooks';
import type { QuotaHistory } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { formatBytes, formatDate, formatPercent } from '../../lib/format';
import { cn } from '../../lib/cn';
import { EmptyState } from '../../components/ui/EmptyState';

const RANGES = [7, 30, 90] as const;
/** Mismo umbral que la tarjeta "casi llena" del resumen. */
const PRESSURE = 85;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

/**
 * Evolución del % ocupado de cada cuenta. Se pinta en porcentaje y no en
 * bytes: con cuentas de distinto tamaño, lo que importa es cuánto le queda a
 * cada una antes de llenarse.
 */
export function QuotaHistoryCard() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const history = useQuotaHistory(days);

  return (
    <section className="card p-5 sm:p-6 animate-rise" style={{ animationDelay: '180ms' }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Evolución de la ocupación</h2>
        <div role="group" aria-label="Periodo" className="flex rounded-lg border border-line p-0.5 text-xs">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={days === range}
              onClick={() => setDays(range)}
              className={cn(
                'rounded-md px-2.5 py-1 font-mono tabular transition-colors',
                days === range ? 'bg-sunken text-ink' : 'text-faint hover:text-ink',
              )}
            >
              {range} d
            </button>
          ))}
        </div>
      </div>
      {history.isPending ? (
        <div className="skeleton mt-4" style={{ height: HEIGHT }} />
      ) : history.isError ? (
        <p className="mt-4 text-sm text-muted">No se pudo cargar el histórico.</p>
      ) : (
        <HistoryBody history={history.data} />
      )}
    </section>
  );
}

function HistoryBody({ history }: { history: QuotaHistory }) {
  // Las cuentas ilimitadas no tienen porcentaje: no caben en este eje.
  const series = history.accounts
    .map(({ account, points }) => ({
      account,
      points: points.filter((p) => p.usedPercent !== null),
      first: points[0],
      last: points.at(-1),
    }))
    .filter((s) => s.points.length > 0);

  if (series.length === 0) {
    return (
      <EmptyState icon={<LineChart className="size-6" />} title="Aún no hay mediciones">
        {history.watchEnabled
          ? 'El vigía de cuota todavía no ha medido en este periodo. Cada pasada añade un punto.'
          : 'El histórico lo registra el vigía de cuota, que está desactivado (QUOTA_WATCH_ENABLED).'}
      </EmptyState>
    );
  }

  return (
    <>
      <Chart series={series} from={Date.parse(history.from)} to={Date.parse(history.to)} />
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        {series.map(({ account, first, last }) => {
          const delta = first && last ? last.usage - first.usage : 0;
          return (
            <li key={account.id} className="flex items-center gap-2">
              <span className="size-2.5 rounded-[3px]" style={{ background: accountColor(account.id) }} />
              <span className="text-ink">{accountLabel(account)}</span>
              <span className="font-mono text-faint tabular">
                {delta >= 0 ? '+' : '−'}
                {formatBytes(Math.abs(delta))}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

type Series = Array<{ account: QuotaHistory['accounts'][number]['account']; points: QuotaHistory['accounts'][number]['points'] }>;

function Chart({ series, from, to }: { series: Series; from: number; to: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);

  // Ancho medido en vez de un viewBox escalado: así el texto y los trazos
  // conservan su tamaño en cualquier ancho de pantalla.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - from) / Math.max(to - from, 1)) * plotW;
  const y = (pct: number) => PAD.top + (1 - Math.min(pct, 100) / 100) * plotH;

  // Punto más cercano al cursor en cada serie, para el detalle al pasar.
  const hoverTime = hoverX === null ? null : from + ((hoverX - PAD.left) / plotW) * (to - from);
  const hovered =
    hoverTime === null
      ? []
      : series.map(({ account, points }) => ({
          account,
          point: points.reduce((best, p) =>
            Math.abs(Date.parse(p.capturedAt) - hoverTime) < Math.abs(Date.parse(best.capturedAt) - hoverTime) ? p : best,
          ),
        }));

  return (
    <div ref={ref} className="relative mt-4" style={{ height: HEIGHT }}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Porcentaje ocupado de ${series.length} cuentas a lo largo del tiempo`}
          onMouseMove={(e) => {
            const left = e.currentTarget.getBoundingClientRect().left;
            const px = e.clientX - left;
            setHoverX(px >= PAD.left && px <= PAD.left + plotW ? px : null);
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          {[0, 25, 50, 75, 100].map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(tick)} y2={y(tick)} stroke="var(--line)" />
              <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-faint font-mono text-[10px]">
                {tick} %
              </text>
            </g>
          ))}
          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={y(PRESSURE)}
            y2={y(PRESSURE)}
            stroke="var(--warn)"
            strokeDasharray="4 4"
            opacity={0.7}
          />
          <text x={PAD.left} y={HEIGHT - 6} className="fill-faint font-mono text-[10px]">
            {formatDate(new Date(from))}
          </text>
          <text x={PAD.left + plotW} y={HEIGHT - 6} textAnchor="end" className="fill-faint font-mono text-[10px]">
            {formatDate(new Date(to))}
          </text>
          {series.map(({ account, points }) => {
            const color = accountColor(account.id);
            const d = points
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(Date.parse(p.capturedAt)).toFixed(1)},${y(p.usedPercent!).toFixed(1)}`)
              .join(' ');
            const last = points.at(-1)!;
            return (
              <g key={account.id}>
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {/* Con una sola muestra no hay línea: el punto la hace visible. */}
                <circle cx={x(Date.parse(last.capturedAt))} cy={y(last.usedPercent!)} r={3} fill={color} />
              </g>
            );
          })}
          {hoverX !== null && (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--line-strong)" />
              {hovered.map(({ account, point }) => (
                <circle
                  key={account.id}
                  cx={x(Date.parse(point.capturedAt))}
                  cy={y(point.usedPercent!)}
                  r={4}
                  fill="var(--surface)"
                  stroke={accountColor(account.id)}
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>
      )}
      {hoverX !== null && hovered.length > 0 && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-line bg-raised px-3 py-2 text-xs shadow-[var(--shadow)]"
          style={hoverX > width / 2 ? { right: width - hoverX + 12 } : { left: hoverX + 12 }}
        >
          <p className="mb-1 font-mono text-faint">{formatDate(hovered[0]!.point.capturedAt)}</p>
          {hovered.map(({ account, point }) => (
            <p key={account.id} className="flex items-center gap-2 whitespace-nowrap">
              <span className="size-2 rounded-[2px]" style={{ background: accountColor(account.id) }} />
              <span>{accountLabel(account)}</span>
              <span className="ml-auto pl-3 font-mono tabular">{formatPercent(point.usedPercent)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
