import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { OrgSwitcher } from './OrgSwitcher.js';
import { logout } from '../../lib/auth.js';
import { api } from '../../lib/api.js';
import { useT, LOCALES } from '../../lib/i18n/index.js';

interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
}

interface UserInfo {
  id: string;
  email: string;
  name: string;
}

function NavItem({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 mx-3 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? 'bg-zinc-800/80 text-zinc-100'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
        }`
      }
    >
      <span className="shrink-0 w-5 h-5 flex items-center justify-center">{icon}</span>
      {label}
    </NavLink>
  );
}

export function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const { t, locale, setLocale } = useT();

  const fetchUser = useCallback(async () => {
    try {
      const data = await api<{ user: UserInfo }>('/v1/auth/me');
      setUser(data.user);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchUser(); }, [fetchUser]);

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-[260px] bg-zinc-950 border-r border-zinc-800/60 flex flex-col transition-transform lg:translate-x-0 lg:static lg:z-auto ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo — always Hovod branding, tinted with org primary color */}
        <div className="flex items-center justify-between h-14 px-5 shrink-0">
          <a href="/videos" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent-600 flex items-center justify-center" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="white">
                <path d="M3 1v12l9.5-6z" />
              </svg>
            </div>
            <span className="text-[15px] font-semibold tracking-tight text-zinc-50">Hovod</span>
          </a>
          {/* Mobile close */}
          <button
            onClick={onClose}
            className="lg:hidden w-7 h-7 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            aria-label={t.nav.closeMenu}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        {/* Org switcher */}
        <div className="px-3 mb-1">
          <OrgSwitcher />
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-3 space-y-1 overflow-y-auto">
          <NavItem
            to="/videos"
            label={t.nav.videos}
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            }
          />
          <NavItem
            to="/analytics"
            label={t.nav.analytics}
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            }
          />
          <NavItem
            to="/api-keys"
            label={t.nav.apiKeys}
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            }
          />
          <NavItem
            to="/members"
            label={t.nav.members}
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            }
          />
          <NavItem
            to="/settings"
            label={t.nav.settings}
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            }
          />
        </nav>

        {/* Footer — Language + User */}
        <div className="shrink-0 border-t border-zinc-800/60">
          {/* Language switcher */}
          <div className="flex items-center justify-center gap-1 px-4 py-2">
            {LOCALES.map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  locale === l
                    ? 'bg-zinc-800 text-zinc-100 font-medium'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
                }`}
              >
                {t.locales[l]}
              </button>
            ))}
          </div>

          {/* User info */}
          {user ? (
            <div className="flex items-center gap-3 px-4 py-3 border-t border-zinc-800/40">
              <div className="w-8 h-8 rounded-full bg-accent-600/20 border border-accent-500/30 flex items-center justify-center shrink-0">
                <span className="text-xs font-semibold text-accent-400 uppercase">
                  {user.name.charAt(0)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-200 truncate">{user.name}</p>
                <p className="text-xs text-zinc-500 truncate">{user.email}</p>
              </div>
              <button
                onClick={logout}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
                aria-label={t.nav.signOut}
                title={t.nav.signOut}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}
