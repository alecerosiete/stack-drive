import type { ReactNode } from 'react';

export function Page({ title, eyebrow, description, actions, children }: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
      <header className="mb-8 flex flex-wrap items-end gap-4 animate-rise">
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="mb-2 font-mono text-[11px] tracking-[0.14em] text-faint uppercase">{eyebrow}</p>}
          <h1 className="font-display text-3xl font-bold tracking-[-0.035em] sm:text-[40px] sm:leading-[1.05]">{title}</h1>
          {description && <p className="mt-2 max-w-2xl text-[15px] text-muted text-pretty">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function FailureList({ failures }: { failures: Array<{ account: { id: string; email: string }; message: string }> }) {
  if (failures.length === 0) return null;
  return (
    <div role="status" className="mb-6 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm animate-rise">
      <p className="font-medium text-warn">
        {failures.length === 1 ? 'Una cuenta no respondió' : `${failures.length} cuentas no respondieron`}; mostramos el resto.
      </p>
      <ul className="mt-1 text-muted">
        {failures.map((f) => (
          <li key={f.account.id}>
            <span className="font-mono text-xs">{f.account.email}</span> — {f.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
