import type { ReactNode } from 'react';

interface MainLayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  /** Mobile sidebar overlay open state */
  sidebarOpen?: boolean;
  /** Callback to close the mobile sidebar overlay */
  onCloseSidebar?: () => void;
}

export function MainLayout({
  header,
  sidebar,
  children,
  sidebarOpen = false,
  onCloseSidebar,
}: MainLayoutProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {header}
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar — always in flow on md+ */}
        <div className="hidden md:flex">
          {sidebar}
        </div>

        {/* Mobile sidebar — overlay with backdrop */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={onCloseSidebar}
            />
            {/* Sidebar panel */}
            <div className="relative z-10 flex animate-slide-in-left">
              {sidebar}
            </div>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
