import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { isLoggedIn } from './lib/auth.js';
import { SettingsProvider } from './lib/settings-context.js';
import { I18nProvider } from './lib/i18n/index.js';
import { DashboardLayout } from './components/layout/DashboardLayout.js';
import { EmbedPlayer } from './components/EmbedPlayer.js';
import { WatchPage } from './components/WatchPage.js';
import { LoginPage } from './components/LoginPage.js';
import { VideosPage } from './pages/VideosPage.js';
import { NewVideoPage } from './pages/NewVideoPage.js';
import { VideoDetailPage } from './pages/VideoDetailPage.js';
import { AnalyticsPage } from './pages/AnalyticsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ApiKeysPage } from './pages/ApiKeysPage.js';
import { MembersPage } from './pages/MembersPage.js';

function AuthGuard() {
  if (!isLoggedIn()) {
    return <LoginPage />;
  }
  return <Outlet />;
}

export function App() {
  return (
    <I18nProvider>
    <SettingsProvider>
    <BrowserRouter>
      <Routes>
        {/* Public routes — no sidebar */}
        <Route path="/embed/:playbackId" element={<EmbedPlayer />} />
        <Route path="/watch/:playbackId" element={<WatchPage />} />
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
    </BrowserRouter>
    </SettingsProvider>
    </I18nProvider>
  );
}
