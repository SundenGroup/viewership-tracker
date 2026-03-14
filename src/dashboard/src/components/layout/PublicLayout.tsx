import type { ReactNode } from 'react';
import type { ConnectionStatus } from '@/hooks/useWebSocket';

interface PublicLayoutProps {
  seriesName: string;
  wsStatus: ConnectionStatus;
  children: ReactNode;
}

export function PublicLayout({ seriesName, wsStatus, children }: PublicLayoutProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-navy-950">
      {/* Minimal header */}
      <header className="sticky top-0 z-40 bg-navy-900/95 backdrop-blur-sm border-b border-navy-800">
        <div className="flex h-14 items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <img
              src="/assets/clutch-logo-white.png"
              alt="Clutch Group"
              className="h-6"
            />
            <span className="text-gray-600">|</span>
            <span className="text-sm font-medium text-gray-300">{seriesName}</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                wsStatus === 'connected'
                  ? 'bg-accent-green'
                  : 'bg-accent-orange animate-pulse'
              }`}
            />
            <span className="text-xs text-gray-500">
              {wsStatus === 'connected' ? 'Live' : 'Connecting…'}
            </span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        {children}
      </main>
    </div>
  );
}
