import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFS: ThemePref[] = ['light', 'dark', 'system'];

export const THEME_LABEL: Record<ThemePref, string> = {
  light: 'light · 浅色',
  dark: 'dark · 深色',
  system: 'system · 跟随系统'
};

const STORAGE_KEY = 'zcode-companion.theme';

export function isThemePref(v: string | null): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'system';
}

function readUrlOverride(): ThemePref | null {
  try {
    const raw = new URL(window.location.href).searchParams.get('theme');
    return isThemePref(raw) ? raw : null;
  } catch {
    return null;
  }
}

function readStored(): ThemePref | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemePref(raw) ? raw : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/**
 * 三态主题。优先级：URL ?theme= 覆盖 > localStorage > system。
 * system 态订阅 prefers-color-scheme，系统切换时即时响应。
 */
export function useTheme(): {
  pref: ThemePref;
  resolved: ResolvedTheme;
  systemDark: boolean;
  source: 'url' | 'storage' | 'default';
  setPref: (p: ThemePref) => void;
} {
  const urlOverride = readUrlOverride();
  const [pref, setPrefState] = useState<ThemePref>(() => urlOverride ?? readStored() ?? 'system');
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(pref, systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset['theme'] = resolved;
    root.dataset['themePref'] = pref;
  }, [resolved, pref]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      window.localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* 存储不可用时仅保留内存态 */
    }
  }, []);

  return {
    pref,
    resolved,
    systemDark,
    source: urlOverride ? 'url' : readStored() ? 'storage' : 'default',
    setPref
  };
}
