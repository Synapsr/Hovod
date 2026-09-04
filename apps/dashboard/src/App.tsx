import { Suspense, lazy, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { isLoggedIn } from './lib/auth.js';
import { SettingsProvider } from './lib/settings-context.js';
import { I18nProvider } from './lib/i18n/index.js';
import { DashboardLayout } from './components/layout/DashboardLayout.js';
import { SubscriptionGate } from './components/SubscriptionGate.js';
import { LoginPage } from './components/LoginPage.js';
import { SignupPage } from './components/SignupPage.js';
import { VideosPage } from './pages/VideosPage.js';
import { NewVideoPage } from './pages/NewVideoPage.js';
import { VideoDetailPage } from './pages/VideoDetailPage.js';
import { AnalyticsPage } from './pages/AnalyticsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ApiKeysPage } from './pages/ApiKeysPage.js';
import { MembersPage } from './pages/MembersPage.js';
import { BillingSuccessPage } from './pages/BillingSuccessPage.js';
import { BillingCancelPage } from './pages/BillingCancelPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { InvitePage } from './pages/InvitePage.js';

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
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        {/* Stripe's cancel_url — reachable without a session so a closed tab still lands somewhere sane */}
        <Route path="/billing/cancel" element={<BillingCancelPage />} />

        {/* Signed in, but outside the gate: this page is what makes the org active */}
        <Route element={<AuthGuard />}>
          <Route path="/billing/success" element={<BillingSuccessPage />} />
        </Route>

        {/* Dashboard routes — with sidebar */}
        <Route element={<AuthGuard />}>
          <Route element={<SubscriptionGate />}>
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
        </Route>
      </Routes>
    </RouteAwareSettings>
    </BrowserRouter>
    </I18nProvider>
  );
}
