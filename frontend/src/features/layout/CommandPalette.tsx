import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeftRight, CornerDownLeft, LayoutGrid, Plus, Scale, Search, Users } from 'lucide-react';
import { useAccounts } from '../../api/hooks';
import { accountColor, accountLabel } from '../../lib/account-color';
import { cn } from '../../lib/cn';
import { Kbd } from '../../components/ui/Kbd';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** Paleta ⌘K: saltar a cualquier cuenta o pantalla, o buscar, sin ratón. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      setQuery('');
      setActive(0);
      el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      onClose();
      navigate(path);
    };
    const base: Command[] = [
      { id: 'home', label: 'Resumen', icon: <LayoutGrid />, run: go('/') },
      { id: 'transfers', label: 'Transferencias', icon: <ArrowLeftRight />, run: go('/transfers') },
      { id: 'rebalance', label: 'Redistribuir cuota', icon: <Scale />, run: go('/rebalance') },
      { id: 'accounts', label: 'Cuentas vinculadas', icon: <Users />, run: go('/accounts') },
      { id: 'link', label: 'Vincular nueva cuenta de Google', icon: <Plus />, run: go('/accounts?link=1') },
      ...(accounts.data ?? [])
        .filter((a) => a.status === 'ACTIVE')
        .map((a) => ({
          id: `acc-${a.id}`,
          label: `Abrir ${accountLabel(a)}`,
          hint: a.alias ? a.email : undefined,
          icon: <span className="block size-3 rounded-[3px]" style={{ background: accountColor(a.id) }} />,
          run: go(`/drive/${a.id}`),
        })),
    ];
    const q = query.trim().toLowerCase();
    const filtered = q ? base.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q)) : base;
    if (q) {
      filtered.push({
        id: 'search',
        label: `Buscar «${query.trim()}» en todas las cuentas`,
        icon: <Search />,
        run: go(`/search?q=${encodeURIComponent(query.trim())}`),
      });
    }
    return filtered;
  }, [accounts.data, navigate, onClose, query]);

  const safeActive = Math.min(active, Math.max(0, commands.length - 1));

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && onClose()}
      className="card mx-auto mt-[12vh] w-[min(92vw,560px)] p-0 text-ink open:animate-pop"
      aria-label="Paleta de comandos"
    >
      {open && (
        <div
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') setActive((safeActive + 1) % Math.max(1, commands.length));
            else if (event.key === 'ArrowUp') setActive((safeActive - 1 + commands.length) % Math.max(1, commands.length));
            else if (event.key === 'Enter') commands[safeActive]?.run();
            else return;
            event.preventDefault();
          }}
        >
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search className="size-4 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder="Ir a… o buscar archivos"
              className="h-13 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={commands[safeActive] ? `cmd-${commands[safeActive].id}` : undefined}
            />
            <Kbd>esc</Kbd>
          </div>
          <ul id="palette-list" role="listbox" className="max-h-80 overflow-y-auto p-2">
            {commands.map((command, index) => (
              <li
                key={command.id}
                id={`cmd-${command.id}`}
                role="option"
                aria-selected={index === safeActive}
                onMouseMove={() => setActive(index)}
                onClick={command.run}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm',
                  index === safeActive ? 'bg-sunken text-ink' : 'text-muted',
                )}
              >
                <span className="grid size-5 place-items-center text-faint [&>svg]:size-4">{command.icon}</span>
                <span className="flex-1 truncate">{command.label}</span>
                {command.hint && <span className="truncate font-mono text-xs text-faint">{command.hint}</span>}
                {index === safeActive && <CornerDownLeft className="size-3.5 text-faint" />}
              </li>
            ))}
            {commands.length === 0 && <li className="px-3 py-6 text-center text-sm text-faint">Sin coincidencias</li>}
          </ul>
        </div>
      )}
    </dialog>
  );
}
