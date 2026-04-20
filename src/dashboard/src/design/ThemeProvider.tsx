import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Theme provider — syncs `data-theme` on <html> and persists to localStorage.
 * Tokens (tokens.css) switch automatically via the `[data-theme="..."]` selector.
 *
 * Per the design v2 spec:
 *   - localStorage key is `clutch-tracker-theme`
 *   - Default is surface-aware (editor surfaces → dark, public/report → light)
 *     unless the user has an explicit stored preference
 *   - Honour prefers-color-scheme only when no explicit pick is stored
 */

export type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'clutch-tracker-theme';
const LEGACY_STORAGE_KEY = 'cvt-theme';

/**
 * Picks an initial theme:
 *   1. Explicit localStorage preference (new or legacy key)
 *   2. Surface default (light for public/report routes, dark otherwise)
 *   3. prefers-color-scheme hint, still biased by surface default
 */
function readInitialTheme(surfaceDefault: Theme): Theme {
  if (typeof window === 'undefined') return surfaceDefault;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    // Migrate legacy key
    if (window.localStorage.getItem(LEGACY_STORAGE_KEY)) {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
  // Honour system preference if available, but only as a nudge:
  // if system says light and surface default says dark, keep dark (editor stays dark).
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    /* ignore */
  }
  return surfaceDefault;
}

export function ThemeProvider({
  children,
  surfaceDefault = 'dark',
}: {
  children: ReactNode;
  surfaceDefault?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => readInitialTheme(surfaceDefault));
  const [hasExplicitPick, setHasExplicitPick] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return !!window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  });

  // Apply to DOM
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Re-evaluate default when surface changes (public → editor route etc.)
  // but only if the user hasn't explicitly picked a theme.
  useEffect(() => {
    if (hasExplicitPick) return;
    setThemeState(readInitialTheme(surfaceDefault));
  }, [surfaceDefault, hasExplicitPick]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    setHasExplicitPick(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  };
  const toggle = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
