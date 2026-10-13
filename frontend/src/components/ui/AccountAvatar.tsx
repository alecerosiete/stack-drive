import { useState } from 'react';
import { accountColor } from '../../lib/account-color';
import { cn } from '../../lib/cn';

/** Foto de Google si existe; si no, inicial sobre el color de capa de la cuenta. */
export function AccountAvatar({ account, size = 28, className }: {
  account: { id: string; email: string; picture?: string | null };
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const color = accountColor(account.id);
  return (
    <span
      className={cn('relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold', className)}
      style={{ width: size, height: size, background: color, color: '#16130f', fontSize: size * 0.42, boxShadow: `0 0 0 2px var(--surface), 0 0 0 3.5px ${color}` }}
      aria-hidden
    >
      {account.picture && !broken ? (
        <img src={account.picture} alt="" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        account.email.charAt(0).toUpperCase()
      )}
    </span>
  );
}

export function AccountDot({ accountId, className }: { accountId: string; className?: string }) {
  return (
    <span className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: accountColor(accountId) }} aria-hidden />
  );
}
