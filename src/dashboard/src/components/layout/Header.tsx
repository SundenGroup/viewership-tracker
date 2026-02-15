import type { TournamentSeries } from '@/types/api';
import type { ConnectionStatus } from '@/hooks/useWebSocket';

export type AppView = 'dashboard' | 'series-setup' | 'series-edit';

interface HeaderProps {
  seriesList: TournamentSeries[];
  selectedSeriesId: string | undefined;
  onSeriesChange: (id: string) => void;
  wsStatus: ConnectionStatus;
  currentView: AppView;
  onNavigate: (view: AppView) => void;
}

const statusConfig: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: 'bg-accent-green', label: 'Live' },
  connecting: { color: 'bg-accent-orange animate-pulse', label: 'Connecting' },
  reconnecting: { color: 'bg-accent-orange animate-pulse', label: 'Reconnecting' },
  disconnected: { color: 'bg-accent-red', label: 'Offline' },
};

const NAV_ITEMS: { view: AppView; label: string; needsSeriesId?: boolean }[] = [
  { view: 'dashboard', label: 'Dashboard' },
  { view: 'series-edit', label: 'Edit Series', needsSeriesId: true },
  { view: 'series-setup', label: 'New Series' },
];

export function Header({
  seriesList,
  selectedSeriesId,
  onSeriesChange,
  wsStatus,
  currentView,
  onNavigate,
}: HeaderProps) {
  const statusCfg = statusConfig[wsStatus];

  return (
    <header className="sticky top-0 z-40 bg-navy-900/95 backdrop-blur-sm">
      <div className="flex h-14 items-center justify-between px-6">
        {/* Logo / Brand + Nav */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            {/* Clutch Brand Mark — abstract 'C' in white on dark */}
            <div className="flex h-8 w-8 items-center justify-center">
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c2.04 0 3.93-.61 5.51-1.66l-1.53-1.78A7.96 7.96 0 0112 20c-4.42 0-8-3.58-8-8s3.58-8 8-8c1.75 0 3.36.57 4.68 1.52l1.56-1.75A9.96 9.96 0 0012 2z"
                  fill="#EBEFF4"
                />
                <path
                  d="M19.5 6.5l-2.8 3.15A5.96 5.96 0 0118 12c0 3.31-2.69 6-6 6-1.2 0-2.31-.35-3.24-.96l-1.53 1.72C8.64 19.58 10.25 20 12 20c4.42 0 8-3.58 8-8 0-2.1-.81-4.01-2.14-5.44l1.64-1.84V6.5z"
                  fill="#EBEFF4"
                  opacity="0.4"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-extrabold text-clutch-white tracking-wide">
                CLUTCH
              </h1>
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-widest">
                Viewership Tracker
              </p>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              // Hide "Edit Series" when no series is selected
              if (item.needsSeriesId && !selectedSeriesId) return null;
              return (
                <button
                  key={item.view}
                  onClick={() => onNavigate(item.view)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    currentView === item.view
                      ? 'bg-navy-800 text-clutch-white'
                      : 'text-gray-500 hover:bg-navy-800/50 hover:text-gray-300'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Series Selector + Status */}
        <div className="flex items-center gap-4">
          <select
            value={selectedSeriesId ?? ''}
            onChange={(e) => onSeriesChange(e.target.value)}
            className="rounded-lg border border-navy-700 bg-navy-800 px-3 py-1.5 text-sm text-gray-200
                       focus:border-clutch-red focus:outline-none focus:ring-1 focus:ring-clutch-red/50"
          >
            <option value="">Select a series...</option>
            {seriesList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          {/* Connection Status */}
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${statusCfg.color}`} />
            <span className="text-xs text-gray-500">{statusCfg.label}</span>
          </div>
        </div>
      </div>

      {/* Clutch Red accent line — brand decorative separator */}
      <div className="h-[2px] bg-gradient-to-r from-clutch-red via-clutch-red/60 to-transparent" />
    </header>
  );
}
