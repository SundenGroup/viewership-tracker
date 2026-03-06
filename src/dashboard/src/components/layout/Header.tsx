import { useNavigate, useLocation } from 'react-router-dom';
import type { TournamentSeries } from '@/types/api';
import type { ConnectionStatus } from '@/hooks/useWebSocket';
import { useAuth } from '@/hooks/useAuth';

interface HeaderProps {
  seriesList: TournamentSeries[];
  selectedSeriesId: string | undefined;
  onSeriesChange: (id: string) => void;
  wsStatus: ConnectionStatus;
  /** Toggle mobile sidebar — visible only below md */
  onToggleSidebar?: () => void;
}

const statusConfig: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: 'bg-accent-green', label: 'Live' },
  connecting: { color: 'bg-accent-orange animate-pulse', label: 'Connecting' },
  reconnecting: { color: 'bg-accent-orange animate-pulse', label: 'Reconnecting' },
  disconnected: { color: 'bg-accent-red', label: 'Offline' },
};

const ROLE_COLORS: Record<string, string> = {
  admin: 'bg-clutch-red/20 text-clutch-red',
  editor: 'bg-amber-500/20 text-amber-400',
  viewer: 'bg-sky-500/20 text-sky-400',
};

export function Header({
  seriesList,
  selectedSeriesId,
  onSeriesChange,
  wsStatus,
  onToggleSidebar,
}: HeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const statusCfg = statusConfig[wsStatus];
  const { user, logout, hasRole, isAdmin } = useAuth();

  // Derive active nav from current URL path
  const pathname = location.pathname;
  const isEditPage = pathname.endsWith('/edit');
  const isNewPage = pathname === '/new';
  const isUsersPage = pathname === '/users';
  const activeNav = isUsersPage
    ? 'users'
    : isNewPage
      ? 'new'
      : isEditPage
        ? 'edit'
        : 'dashboard';

  // Build nav items based on role
  const navItems: { id: string; label: string; show: boolean; path: string }[] = [
    { id: 'dashboard', label: 'Dashboard', show: true, path: selectedSeriesId ? `/${selectedSeriesId}` : '/' },
    { id: 'edit', label: 'Edit Series', show: hasRole('editor') && !!selectedSeriesId, path: `/${selectedSeriesId}/edit` },
    { id: 'new', label: 'New Series', show: isAdmin, path: '/new' },
    { id: 'users', label: 'Users', show: isAdmin, path: '/users' },
  ];

  return (
    <header className="sticky top-0 z-40 bg-navy-900/95 backdrop-blur-sm">
      <div className="flex h-14 items-center justify-between px-3 md:px-6">
        {/* Logo / Brand + Nav */}
        <div className="flex items-center gap-3 md:gap-6">
          {/* Hamburger — mobile only */}
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="flex items-center justify-center rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-navy-800 hover:text-gray-200 md:hidden"
              aria-label="Toggle sidebar"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
              </svg>
            </button>
          )}

          <div className="flex items-center gap-2">
            {/* Official Clutch horizontal logo */}
            <img
              src="/assets/clutch-logo-white.png"
              alt="Clutch Group"
              className="h-6"
            />
            <span className="hidden text-[10px] font-medium text-gray-500 uppercase tracking-widest border-l border-navy-700 pl-2 sm:inline">
              Viewership Tracker
            </span>
          </div>

          {/* Navigation — hidden on mobile */}
          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => {
              if (!item.show) return null;
              return (
                <button
                  key={item.id}
                  onClick={() => navigate(item.path)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    activeNav === item.id
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

        {/* Series Selector + Status + User */}
        <div className="flex items-center gap-2 md:gap-4">
          <select
            value={selectedSeriesId ?? ''}
            onChange={(e) => onSeriesChange(e.target.value)}
            className="max-w-[140px] rounded-lg border border-navy-700 bg-navy-800 px-2 py-1.5 text-sm text-gray-200
                       focus:border-clutch-red focus:outline-none focus:ring-1 focus:ring-clutch-red/50
                       md:max-w-none md:px-3"
          >
            <option value="">Select a series...</option>
            {seriesList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          {/* Connection Status — hidden on mobile */}
          <div className="hidden items-center gap-2 md:flex">
            <span className={`h-2 w-2 rounded-full ${statusCfg.color}`} />
            <span className="text-xs text-gray-500">{statusCfg.label}</span>
          </div>

          {/* Mobile: connection dot only (no label) */}
          <span className={`h-2 w-2 flex-shrink-0 rounded-full md:hidden ${statusCfg.color}`} />

          {/* User menu */}
          {user && (
            <div className="flex items-center gap-2 border-l border-navy-700 pl-2 md:pl-4">
              <span className="hidden text-xs text-gray-400 md:inline">{user.display_name}</span>
              <span
                className={`hidden rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide md:inline ${
                  ROLE_COLORS[user.role] ?? 'bg-gray-500/20 text-gray-400'
                }`}
              >
                {user.role}
              </span>
              <button
                onClick={logout}
                className="rounded-md px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-navy-800 hover:text-gray-300"
                title="Sign out"
              >
                <span className="hidden md:inline">Sign Out</span>
                {/* Mobile: just an icon */}
                <svg className="h-4 w-4 md:hidden" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1H3zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Clutch Red accent line — brand decorative separator */}
      <div className="h-[2px] bg-gradient-to-r from-clutch-red via-clutch-red/60 to-transparent" />
    </header>
  );
}
