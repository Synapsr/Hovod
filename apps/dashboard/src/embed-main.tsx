import React from 'react';
import { createRoot } from 'react-dom/client';
import './embed.css';
import { I18nProvider } from './lib/i18n/index.js';
import { EmbedPlayer } from './components/EmbedPlayer.js';

// Standalone entry for /embed/:playbackId — ships only the player (no dashboard, no router).
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <EmbedPlayer />
    </I18nProvider>
  </React.StrictMode>
);
