import { useTheme } from '@/design/ThemeProvider';
import { IconMoon, IconSun } from './icons';

export function ThemeToggle({ size = 14 }: { size?: number }) {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="btn btn-ghost btn-xs"
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle theme"
      style={{ padding: 6 }}
    >
      {theme === 'dark' ? <IconSun size={size} /> : <IconMoon size={size} />}
    </button>
  );
}
