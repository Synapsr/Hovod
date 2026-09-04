import { Suspense, lazy, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { isLoggedIn } from './lib/auth.js';
import { SettingsProvider } from './lib/settings-context.js';
import { I18nProvider } from './lib/i18n/index.js';
import { DashboardLayout } from './components/layout/DashboardLayout.js';
import { LoginPage } from './components/LoginPage.js';
import { VideosPage } from './pages/VideosPage.js';
import { NewVideoPage } from './pages/NewVideoPage.js';
import { VideoDetailPage } from './pages/VideoDetailPage.js';
import { AnalyticsPage } from './pages/AnalyticsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ApiKeysPage } from './pages/ApiKeysPage.js';
import { MembersPage } from './pages/MembersPage.js';

// Public player pages are code-split so the dashboard bundle does not carry hls.js
// (the /embed route is normally served by the standalone embed entry, this is the SPA fallback)
const EmbedPlayer = lazy(() => import('./components/EmbedPlayer.js').then((m) => ({ default: m.EmbedPlayer })));
const WatchPage = lazy(() => import('./components/WatchPage.js').then((m) => ({ default: m.WatchPage })));

/** Public pages (/embed, /watch) must not fetch the authenticated org settings — the playback response carries them. */
const PUBLIC_ROUTE_RE = /^\/(embed|watch)\//;

function AuthGuard() {
  if (!isLoggedIn()) {
    return <LoginPage />;
  }
  return <Outlet />;
}

function RouteAwareSettings({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <SettingsProvider enabled={!PUBLIC_ROUTE_RE.test(pathname)}>{children}</SettingsProvider>;
}

function PublicFallback() {
  return <div className="min-h-screen bg-zinc-950" />;
}

export function App() {
  return (
    <I18nProvider>
    <BrowserRouter>
    <RouteAwareSettings>
      <Routes>
        {/* Public routes — no sidebar */}
        <Route path="/embed/:playbackId" element={<Suspense fallback={<PublicFallback />}><EmbedPlayer /></Suspense>} />
        <Route path="/watch/:playbackId" element={<Suspense fallback={<PublicFallback />}><WatchPage /></Suspense>} />
        <Route path="/login" element={<LoginPage />} />

        {/* Dashboard routes — with sidebar */}
        <Route element={<AuthGuard />}>
          <Route element={<DashboardLayout />}>
            <Route index element={<Navigate to="/videos" replace />} />
            <Route path="/videos" element={<VideosPage />} />
            <Route path="/videos/new" element={<NewVideoPage />} />
            <Route path="/videos/:id" element={<VideoDetailPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/api-keys" element={<ApiKeysPage />} />
            <Route path="/members" element={<MembersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Route>
      </Routes>
    </RouteAwareSettings>
    </BrowserRouter>
    </I18nProvider>
  );
}
