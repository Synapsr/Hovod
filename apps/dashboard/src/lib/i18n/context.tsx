import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Locale, Translations } from './types.js';
import { en } from './en.js';
import { fr } from './fr.js';
import { de } from './de.js';
import { es } from './es.js';

const STORAGE_KEY = 'hovod-locale';

const locales: Record<Locale, Translations> = { en, fr, de, es };

function detectLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (stored && stored in locales) return stored;
  const lang = navigator.language.slice(0, 2).toLowerCase();
  if (lang in locales) return lang as Locale;
  return 'en';
}

interface I18nContextValue {
  t: Translations;
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nContextValue>({
  t: en,
  locale: 'en',
  setLocale: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = (l: Locale) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLocaleState(l);
  };

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ t: locales[locale], locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  return useContext(I18nContext);
}

export const LOCALES: Locale[] = ['en', 'fr', 'de', 'es'];
