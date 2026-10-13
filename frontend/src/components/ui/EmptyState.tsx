import type { ReactNode } from 'react';

export function EmptyState({ icon, title, children, action }: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center animate-rise">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-line bg-raised text-faint shadow-[var(--shadow)]">
        {icon}
      </div>
      <h3 className="font-display text-lg font-semibold tracking-tight">{title}</h3>
      {children && <p className="mt-1.5 max-w-sm text-sm text-muted text-balance">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
