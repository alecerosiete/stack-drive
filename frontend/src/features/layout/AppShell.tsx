import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  ChevronDown,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Plus,
  Scale,
  Search,
  Sun,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { isActiveJob, logout, useAccounts, useProfile, useTransfers } from '../../api/hooks';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { Kbd } from '../../components/ui/Kbd';
import { Menu } from '../../components/ui/Menu';
import { Logo } from './Logo';
import { CommandPalette } from './CommandPalette';
import { UploadTray } from '../uploads/UploadTray';
import { TransferDialog } from '../transfers/TransferDialog';
import { dragSourceAccount, isItemsDrag, readItemsDrag, transferIntent } from '../transfers/transfer-intent';

const NAV = [
  { to: '/', label: 'Resumen', icon: LayoutGrid, end: true },
  { to: '/search', label: 'Buscar', icon: Search },
  { to: '/rebalance', label: 'Redistribuir', icon: Scale },
  { to: '/transfers', label: 'Transferencias', icon: ArrowLeftRight },
  { to: '/accounts', label: 'Cuentas', icon: Users },
];

function navClass({ isActive }: { isActive: boolean }) {
  return cn(
    'group flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
    isActive ? 'bg-raised text-ink shadow-[var(--shadow)] ring-1 ring-line' : 'text-muted hover:bg-sunken/60 hover:text-ink',
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const accounts = useAccounts();
  const transfers = useTransfers();
  const running = transfers.data?.filter(isActiveJob).length ?? 0;
  const linked = accounts.data?.filter((a) => a.status !== 'REVOKED') ?? [];
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Soltar archivos de una cuenta sobre otra de la pila abre el diálogo de
  // transferencia con ese destino ya elegido. Una cuenta no acepta lo que
  // viene de ella misma, ni puede recibir si necesita reautorizarse.
  const accepts = (event: React.DragEvent, accountId: string, blocked: boolean) =>
    !blocked && isItemsDrag(event) && dragSourceAccount(event) !== accountId.toLowerCase();

  return (
    <nav className="flex h-full flex-col gap-6 px-3 py-5" aria-label="Principal" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="px-2.5">
        <Logo />
      </div>

      <ul className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <li key={to}>
            <NavLink to={to} end={end} className={navClass}>
              <Icon className="size-4 opacity-80" />
              <span className="flex-1">{label}</span>
              {to === '/transfers' && running > 0 && (
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 font-mono text-[11px] text-accent-ink">{running}</span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex items-center justify-between px-2.5">
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-faint uppercase">Pila · {linked.length}</h2>
          <NavLink to="/accounts?link=1" className="rounded-md p-1 text-faint hover:bg-sunken hover:text-ink" aria-label="Vincular cuenta" title="Vincular cuenta">
            <Plus className="size-3.5" />
          </NavLink>
        </div>
        <ul className="-mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1">
          {accounts.isPending &&
            Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="flex h-9 items-center gap-3 px-2.5">
                <span className="skeleton size-2.5 rounded-full" />
                <span className="skeleton h-3 flex-1" />
              </li>
            ))}
          {linked.map((account) => (
            <li
              key={account.id}
              onDragOver={(event) => {
                if (!accepts(event, account.id, account.needsReauth)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDropTarget(account.id);
              }}
              onDragLeave={() => setDropTarget((current) => (current === account.id ? null : current))}
              onDrop={(event) => {
                setDropTarget(null);
                const payload = readItemsDrag(event);
                if (!payload || payload.accountId === account.id) return;
                event.preventDefault();
                transferIntent.open({ accountId: payload.accountId, items: payload.items, targetId: account.id });
              }}
              className={cn('rounded-lg transition-shadow', dropTarget === account.id && 'ring-2 ring-offset-2 ring-offset-surface')}
              style={dropTarget === account.id ? ({ '--tw-ring-color': accountColor(account.id) } as React.CSSProperties) : undefined}
            >
              <NavLink to={`/drive/${account.id}`} className={navClass} title={account.email}>
                <span className="relative size-2.5 shrink-0 rounded-[3px]" style={{ background: accountColor(account.id) }} />
                <span className="min-w-0 flex-1 truncate">{accountLabel(account)}</span>
                {account.needsReauth && <TriangleAlert className="size-3.5 text-warn" aria-label="Necesita reautorizar" />}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

const THEME_ICONS: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const profile = useProfile();
  const [theme, setTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const ThemeIcon = THEME_ICONS[theme];

  // Atajos globales: ⌘K / Ctrl+K paleta de comandos, "/" enfoca la búsqueda.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement).closest('input, textarea, [contenteditable], select');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const currentQuery = location.pathname === '/search' ? (new URLSearchParams(location.search).get('q') ?? '') : '';

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface/60 lg:block">
        <Sidebar />
      </aside>

      {/* Cajón móvil */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50 animate-fade" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface animate-rise">
            <button className="absolute top-5 right-3 rounded-lg p-1.5 text-faint hover:text-ink" onClick={() => setDrawerOpen(false)} aria-label="Cerrar menú">
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur-md sm:px-6">
          <button className="rounded-lg p-2 text-muted hover:bg-sunken lg:hidden" onClick={() => setDrawerOpen(true)} aria-label="Abrir menú">
            <MenuIcon className="size-5" />
          </button>

          <form
            role="search"
            className="relative max-w-xl flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              const q = new FormData(event.currentTarget).get('q')?.toString().trim();
              if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input
              ref={searchRef}
              key={currentQuery}
              name="q"
              defaultValue={currentQuery}
              placeholder="Buscar en la pila…"
              aria-label="Buscar en todas las cuentas"
              className="h-10 w-full rounded-[10px] border border-line bg-surface pr-24 pl-9 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent/15"
            />
            <span className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 items-center gap-1 sm:flex">
              <Kbd>/</Kbd>
              <span className="text-[11px] text-faint">o</span>
              <Kbd>⌘K</Kbd>
            </span>
          </form>

          <div className="ml-auto flex items-center gap-1">
            <button
              className="rounded-lg p-2 text-muted transition-colors hover:bg-sunken hover:text-ink"
              onClick={() => setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')}
              aria-label={`Tema: ${theme === 'system' ? 'sistema' : theme === 'dark' ? 'oscuro' : 'claro'}. Cambiar`}
              title="Cambiar tema"
            >
              <ThemeIcon className="size-[18px]" />
            </button>

            <Menu
              label="Cuenta de StackDrive"
              trigger={(props) => (
                <button {...props} className="flex items-center gap-2 rounded-lg py-1.5 pr-2 pl-1.5 text-sm hover:bg-sunken">
                  <span className="grid size-7 place-items-center rounded-full bg-ink font-display text-[13px] font-bold text-canvas">
                    {(profile.data?.displayName || profile.data?.email || '·').charAt(0).toUpperCase()}
                  </span>
                  <span className="hidden max-w-40 truncate text-muted md:block">{profile.data?.displayName || profile.data?.email}</span>
                  <ChevronDown className="size-3.5 text-faint" />
                </button>
              )}
              items={[
                { label: 'Cuentas vinculadas', icon: <Users />, onSelect: () => navigate('/accounts') },
                { label: 'Cerrar sesión', icon: <LogOut />, separatorBefore: true, onSelect: () => void logout(queryClient) },
                { label: 'Cerrar sesión en todos lados', icon: <LogOut />, danger: true, onSelect: () => void logout(queryClient, true) },
              ]}
            />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <UploadTray />
      <TransferDialog />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
