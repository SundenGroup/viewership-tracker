import type { ReactNode } from 'react';

interface MainLayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}

export function MainLayout({ header, sidebar, children }: MainLayoutProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {header}
      <div className="flex flex-1 overflow-hidden">
        {sidebar}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
