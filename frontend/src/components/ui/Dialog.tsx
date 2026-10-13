import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Sobre `<dialog>` nativo: el navegador ya resuelve el foco atrapado, Escape,
 * `inert` del fondo y la capa superior, mejor que cualquier reimplementación.
 */
export function Dialog({ open, onClose, title, description, children, footer, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // Clic en el backdrop: el evento llega al propio <dialog>.
      onClick={(event) => event.target === ref.current && onClose()}
      className={cn(
        'card m-auto w-[min(92vw,480px)] p-0 text-ink backdrop:animate-fade open:animate-pop',
        className,
      )}
    >
      {open && (
        <div className="flex flex-col">
          <header className="flex items-start gap-4 px-6 pt-5 pb-4">
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="-mr-2 rounded-lg p-1.5 text-faint transition-colors hover:bg-sunken hover:text-ink"
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="px-6 pb-5">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-line bg-sunken/30 px-6 py-3.5 rounded-b-[var(--radius-card)]">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
