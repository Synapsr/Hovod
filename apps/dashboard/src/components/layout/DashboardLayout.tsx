import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useSettings } from '../../lib/settings-context.js';
import { useT } from '../../lib/i18n/index.js';
import { Sidebar } from './Sidebar.js';

export function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { settings } = useSettings();
  const { t } = useT();

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-50">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden sticky top-0 z-20 flex items-center h-14 px-4 bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800/60">
          <button
            onClick={() => setMobileOpen(true)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            aria-label={t.nav.openMenu}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <a href="/videos" className="flex items-center gap-2 ml-3">
            {settings.logoUrl ? (
              <img src={settings.logoUrl} alt="Logo" className="w-6 h-6 rounded-lg object-contain" />
            ) : (
              <div className="w-6 h-6 rounded-lg bg-accent-600 flex items-center justify-center" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 14 14" fill="white">
                  <path d="M3 1v12l9.5-6z" />
                </svg>
              </div>
            )}
            <span className="text-sm font-semibold tracking-tight">Hovod</span>
          </a>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-6 py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
