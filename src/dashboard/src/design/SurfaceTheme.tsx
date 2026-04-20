import { useLocation } from 'react-router-dom';
import { ThemeProvider, type Theme } from './ThemeProvider';
import type { ReactNode } from 'react';

/**
 * Wraps <ThemeProvider> with a surface-aware default. Editor routes default
 * to dark, public/report routes default to light. Explicit user picks stored
 * in localStorage always win.
 */
export function SurfaceThemeProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const surfaceDefault: Theme = location.pathname.startsWith('/public/') ? 'light' : 'dark';
  return <ThemeProvider surfaceDefault={surfaceDefault}>{children}</ThemeProvider>;
}
