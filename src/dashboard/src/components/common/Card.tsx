import { useState, type ReactNode } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  noPadding?: boolean;
  /** Enable collapse toggle on the card header. */
  collapsible?: boolean;
  /** localStorage key to persist collapsed state across sessions. */
  storageKey?: string;
}

export function Card({
  children,
  className = '',
  title,
  subtitle,
  action,
  noPadding = false,
  collapsible = false,
  storageKey,
}: CardProps) {
  // Persisted state when storageKey is provided, otherwise local state
  const [storedCollapsed, setStoredCollapsed] = useLocalStorage<boolean>(
    storageKey ?? '__unused__',
    false,
  );
  const [localCollapsed, setLocalCollapsed] = useState(false);

  const collapsed = storageKey ? storedCollapsed : localCollapsed;
  const setCollapsed = storageKey ? setStoredCollapsed : setLocalCollapsed;

  const hasHeader = !!(title || action);

  return (
    <div
      // Use the design-token `.card` class so background/border flip
      // with the theme (the previous `bg-navy-850 border-navy-700/50`
      // Tailwind classes were hardcoded dark; light mode showed up as
      // dark cards on a light page — most visible on /settings/youtube-keys).
      className={`card shadow-lg ${className}`}
    >
      {hasHeader && (
        <div
          className={`flex items-center justify-between px-5 py-3 ${
            collapsible ? 'cursor-pointer select-none' : ''
          }`}
          style={{
            borderBottom: collapsed ? 'none' : '1px solid var(--border)',
          }}
          onClick={collapsible ? () => setCollapsed(!collapsed) : undefined}
        >
          <div className="flex items-center gap-2">
            {collapsible && (
              <svg
                className={`h-3 w-3 transition-transform duration-200 ${
                  collapsed ? '-rotate-90' : ''
                }`}
                style={{ color: 'var(--fg-dim)' }}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            {title && (
              <>
                <span
                  className="inline-block h-4 w-[2px] rounded-full"
                  style={{ background: 'var(--red)' }}
                />
                <h3
                  className="text-sm font-semibold"
                  style={{ color: 'var(--fg)' }}
                >
                  {title}
                </h3>
              </>
            )}
            {subtitle && (
              <p
                className="mt-0.5 text-xs"
                style={{ color: 'var(--fg-muted)' }}
              >
                {subtitle}
              </p>
            )}
          </div>
          {action && (
            <div onClick={(e) => e.stopPropagation()}>{action}</div>
          )}
        </div>
      )}
      {!collapsed && (
        <div className={noPadding ? '' : 'p-5'}>{children}</div>
      )}
    </div>
  );
}
