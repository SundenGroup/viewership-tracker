import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  noPadding?: boolean;
}

export function Card({
  children,
  className = '',
  title,
  subtitle,
  action,
  noPadding = false,
}: CardProps) {
  return (
    <div
      className={`rounded-xl border border-navy-700/50 bg-navy-850 shadow-lg ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-navy-700/50 px-5 py-3">
          <div className="flex items-center gap-2">
            {title && (
              <>
                <span className="inline-block h-4 w-[2px] rounded-full bg-clutch-red" />
                <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
              </>
            )}
            {subtitle && (
              <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
            )}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      <div className={noPadding ? '' : 'p-5'}>{children}</div>
    </div>
  );
}
