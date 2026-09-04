import type { ReactNode } from 'react';

/** The Hovod mark used on every logged-out page. */
export function AuthLogo() {
  return (
    <div className="flex justify-center mb-8">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-accent-600 flex items-center justify-center" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
            <path d="M3 1v12l9.5-6z" />
          </svg>
        </div>
        <span className="text-lg font-semibold tracking-tight text-zinc-50">Hovod</span>
      </div>
    </div>
  );
}

/**
 * Centred card layout shared by sign-in, sign-up, password reset and invitation
 * pages, so they line up pixel for pixel whichever one the user lands on.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  width = 'sm',
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'lg';
}) {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4 py-10">
      <div className={width === 'lg' ? 'w-full max-w-3xl' : 'w-full max-w-sm'}>
        <AuthLogo />
        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-2xl p-6">
          <h1 className="text-lg font-semibold text-zinc-50 text-center mb-1">{title}</h1>
          {subtitle && <p className="text-sm text-zinc-500 text-center mb-6">{subtitle}</p>}
          {children}
        </div>
        {footer && <div className="text-center text-sm text-zinc-500 mt-5">{footer}</div>}
      </div>
    </div>
  );
}

/** Text input with the dashboard's field styling. */
export function AuthField({
  id,
  label,
  ...input
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</label>
      <input
        id={id}
        {...input}
        className="w-full h-10 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
      />
    </div>
  );
}

export function AuthError({ message }: { message: string }) {
  return (
    <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2" role="alert">
      {message}
    </p>
  );
}

export function AuthSubmit({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      {...props}
      className="w-full h-10 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-1"
    >
      {children}
    </button>
  );
}
