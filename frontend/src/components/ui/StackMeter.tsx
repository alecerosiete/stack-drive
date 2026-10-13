import { useState } from 'react';
import type { StorageQuota } from '../../api/types';
import { accountColor, accountLabel } from '../../lib/account-color';
import { formatBytes } from '../../lib/format';
import { cn } from '../../lib/cn';

/**
 * Pieza central de la identidad visual: todas las cuentas como capas de una
 * sola barra de capacidad. Cada segmento es una cuenta; el relleno sólido es
 * lo usado y el rayado tenue el hueco que le queda.
 */
export function StackMeter({ quotas, className, height = 44 }: {
  quotas: StorageQuota[];
  className?: string;
  height?: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const capacity = quotas.reduce((sum, q) => sum + (q.limit ?? q.usage), 0);
  if (capacity === 0) return <div className={cn('skeleton', className)} style={{ height }} />;

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`Ocupación combinada de ${quotas.length} cuentas`}
        className="flex w-full gap-[3px] overflow-hidden rounded-xl"
        style={{ height }}
        onMouseLeave={() => setHovered(null)}
      >
        {quotas.map((q, index) => {
          const total = q.limit ?? q.usage;
          const color = accountColor(q.account.id);
          const usedRatio = total > 0 ? Math.min(1, q.usage / total) : 0;
          const dim = hovered !== null && hovered !== q.account.id;
          return (
            <div
              key={q.account.id}
              onMouseEnter={() => setHovered(q.account.id)}
              className="relative h-full min-w-2 overflow-hidden rounded-[5px] transition-[opacity,flex-grow] duration-300 animate-rise first:rounded-l-xl last:rounded-r-xl"
              style={{
                flexGrow: total,
                flexBasis: 0,
                opacity: dim ? 0.35 : 1,
                animationDelay: `${index * 70}ms`,
                background: `repeating-linear-gradient(135deg, ${color}26 0 6px, ${color}12 6px 12px)`,
                boxShadow: `inset 0 0 0 1px ${color}40`,
              }}
              title={`${accountLabel(q.account)} · ${formatBytes(q.usage)} de ${formatBytes(q.limit)}`}
            >
              <div
                className="absolute inset-y-0 left-0 origin-left transition-[width] duration-700 ease-out"
                style={{ width: `${usedRatio * 100}%`, background: color }}
              />
            </div>
          );
        })}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        {quotas.map((q) => (
          <li
            key={q.account.id}
            onMouseEnter={() => setHovered(q.account.id)}
            onMouseLeave={() => setHovered(null)}
            className={cn('flex items-center gap-2 transition-opacity', hovered && hovered !== q.account.id && 'opacity-40')}
          >
            <span className="size-2.5 rounded-[3px]" style={{ background: accountColor(q.account.id) }} />
            <span className="text-ink">{accountLabel(q.account)}</span>
            <span className="font-mono text-faint tabular">
              {formatBytes(q.usage)} / {formatBytes(q.limit)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Barra fina de ocupación de una sola cuenta, coloreada según presión. */
export function QuotaBar({ percent, color, className }: { percent: number | null; color?: string; className?: string }) {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  const tone = value >= 90 ? 'var(--danger)' : value >= 75 ? 'var(--warn)' : (color ?? 'var(--accent)');
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-sunken', className)}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${value}%`, background: tone }} />
    </div>
  );
}
