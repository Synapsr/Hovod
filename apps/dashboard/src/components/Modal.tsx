import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Stacked modals must not fight over the body scroll lock. */
let scrollLocks = 0;
let savedOverflow = '';
let savedPaddingRight = '';

function lockBodyScroll(): () => void {
  if (scrollLocks === 0) {
    savedOverflow = document.body.style.overflow;
    savedPaddingRight = document.body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
  }
  scrollLocks++;
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    // Whichever modal closes last restores the page — not necessarily the one
    // that took the lock.
    if (scrollLocks === 0) {
      document.body.style.overflow = savedOverflow;
      document.body.style.paddingRight = savedPaddingRight;
    }
  };
}

export interface ModalProps {
  /** Called for Escape, the close button and a backdrop click. */
  onClose: () => void;
  /** Accessible name of the dialog. */
  title: string;
  children: ReactNode;
  /** false while a request is in flight — Escape / backdrop / close button do nothing. */
  dismissible?: boolean;
  /** Render the title bar. Turn it off for dialogs that draw their own header. */
  showHeader?: boolean;
  size?: 'sm' | 'md' | 'lg';
  align?: 'top' | 'center';
  /** Light variant for the public watch page. */
  theme?: 'dark' | 'light';
  /** Extra classes on the dialog panel. */
  className?: string;
}

/**
 * Accessible modal primitive: focus trap, focus restore, Escape to close,
 * backdrop click to close, body scroll lock, labelled by its title.
 * Mount it conditionally (`{open && <Modal …/>}`) so its content remounts —
 * that is what keeps form drafts from going stale between openings.
 */
export function Modal({
  onClose,
  title,
  children,
  dismissible = true,
  showHeader = true,
  size = 'md',
  align = 'top',
  theme = 'dark',
  className = '',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const dark = theme === 'dark';

  // `dismissible` changes while a request is in flight; keep the handlers stable.
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  const requestClose = useCallback(() => {
    if (dismissibleRef.current) onClose();
  }, [onClose]);

  /* Body scroll lock */
  useEffect(lockBodyScroll, []);

  /* Focus restore + initial focus */
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);

  /* Escape + focus trap */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [requestClose]);

  const maxWidth = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-md';

  return (
    <div className={`fixed inset-0 z-50 flex justify-center ${align === 'center' ? 'items-center p-4' : 'items-start pt-[8vh]'}`}>
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative z-10 w-full ${maxWidth} mx-4 max-h-[84vh] overflow-y-auto rounded-2xl shadow-2xl outline-none animate-slideUp ${
          dark ? 'bg-zinc-900 border border-zinc-800' : 'bg-white border border-zinc-200'
        } ${className}`}
      >
        {showHeader ? (
          <div className="flex items-center justify-between px-6 pt-5 pb-0">
            <h2 id={titleId} className={`text-base font-semibold ${dark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {title}
            </h2>
            <button
              type="button"
              onClick={requestClose}
              disabled={!dismissible}
              aria-label={title}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
                dark
                  ? 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'
                  : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100'
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <h2 id={titleId} className="sr-only">{title}</h2>
        )}
        {children}
      </div>
    </div>
  );
}
