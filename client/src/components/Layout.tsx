import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { NavRail } from './NavRail';
import { CommandPalette } from './CommandPalette';
import { AdvisorChatProvider } from '../hooks/advisorChat';

export function Layout() {
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <AdvisorChatProvider>
      <div className="flex h-screen overflow-hidden bg-paper">
        <CommandPalette />
        <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <Outlet />
        </main>
        <NavRail />
      </div>
    </AdvisorChatProvider>
  );
}
