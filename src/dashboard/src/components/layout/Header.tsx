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
          <div className="flex items-center gap-2">
            {/* Official Clutch horizontal logo */}
            <img
              src="/assets/clutch-logo-white.png"
              alt="Clutch Group"
              className="h-6"
            />
            <span className="text-[10px] font-medium text-gray-500 uppercase tracking-widest border-l border-navy-700 pl-2">
              Viewership Tracker
            </span>
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
