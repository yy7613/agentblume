import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Language = 'en' | 'ja';
const STORAGE_KEY = 'agentcontext.language';
interface I18nValue {
  readonly language: Language;
  readonly setLanguage: (language: Language) => void;
  readonly text: (english: string, japanese: string) => string;
}
const I18nContext = createContext<I18nValue>({ language: 'en', setLanguage: () => {}, text: (english) => english });

function storedLanguage(): Language {
  try { return localStorage.getItem(STORAGE_KEY) === 'ja' ? 'ja' : 'en'; }
  catch { return 'en'; }
}

export function I18nProvider({ children, initialLanguage }: { readonly children: ReactNode; readonly initialLanguage?: Language }) {
  const [language, setLanguageState] = useState<Language>(() => initialLanguage ?? storedLanguage());
  useEffect(() => { document.documentElement.lang = language; try { localStorage.setItem(STORAGE_KEY, language); } catch { /* Storage can be unavailable in embedded browsers. */ } }, [language]);
  const value = useMemo<I18nValue>(() => ({ language, setLanguage: setLanguageState, text: (english, japanese) => language === 'ja' ? japanese : english }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue { return useContext(I18nContext); }
