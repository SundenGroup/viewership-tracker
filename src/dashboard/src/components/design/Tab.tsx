import type { ReactNode } from 'react';

export function Tab({
  active,
  children,
  onClick,
  icon,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
  icon?: ReactNode;
}) {
  return (
    <button aria-current={active ? "page" : undefined}
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        background: active ? 'var(--bg-hover)' : 'transparent',
        border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
        cursor: 'pointer',
      }}
    >
      {icon}
      {children}
    </button>
  );
}
