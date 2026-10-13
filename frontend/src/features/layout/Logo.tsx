export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      <svg viewBox="0 0 28 28" className="size-7" aria-hidden>
        <rect x="3" y="4" width="22" height="5" rx="2.5" fill="#ff7a3d" />
        <rect x="3" y="11.5" width="22" height="5" rx="2.5" fill="#3fb8a6" />
        <rect x="3" y="19" width="22" height="5" rx="2.5" fill="#e8c547" />
      </svg>
      <span className="font-display text-[19px] font-bold tracking-[-0.03em]">
        Stack<span className="text-accent">Drive</span>
      </span>
    </span>
  );
}
