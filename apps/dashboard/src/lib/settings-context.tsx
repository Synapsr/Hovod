import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api } from './api.js';
import type { PlatformSettings } from './types.js';

const DEFAULT_SETTINGS: PlatformSettings = {
  primaryColor: '#4f46e5',
  theme: 'dark',
  logoUrl: null,
  aiAutoTranscribe: true,
  aiAutoChapter: true,
};

interface SettingsContextValue {
  settings: PlatformSettings;
  loading: boolean;
  refetch: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loading: true,
  refetch: async () => {},
});

export function useSettings() {
  return useContext(SettingsContext);
}

/* ─── Color conversion ───────────────────────────────────── */

function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function applyAccentColor(hex: string) {
  const root = document.documentElement;
  const { h, s, l } = hexToHSL(hex);

  root.style.setProperty('--color-accent-400', `${h} ${s}% ${Math.min(l + 13, 90)}%`);
  root.style.setProperty('--color-accent-500', `${h} ${s}% ${Math.min(l + 3, 80)}%`);
  root.style.setProperty('--color-accent-600', `${h} ${s}% ${l}%`);
  root.style.setProperty('--color-accent-700', `${h} ${s}% ${Math.max(l - 10, 10)}%`);
}

/* ─── Provider ───────────────────────────────────────────── */

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PlatformSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const data = await api<PlatformSettings>('/v1/settings');
      setSettings(data);
      applyAccentColor(data.primaryColor);
    } catch {
      applyAccentColor(DEFAULT_SETTINGS.primaryColor);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return (
    <SettingsContext.Provider value={{ settings, loading, refetch }}>
      {children}
    </SettingsContext.Provider>
  );
}
