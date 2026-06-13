'use client';

import { AppSidebar } from '@/components/pod-scheduler/app-sidebar';
import { DemoBanner } from '@/components/pod-scheduler/demo-banner';
import { TopBar } from '@/components/pod-scheduler/top-bar';
import { SidebarProvider, useSidebar } from '@/components/pod-scheduler/sidebar-context';
import { SessionProvider, AccessGate } from '@/components/auth/session-context';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

function MainContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { collapsed, isMobile } = useSidebar();
  const useCollapsedOffset = collapsed || isMobile;

  return (
    <div
      className={cn(
        'app-content min-h-screen transition-[margin,width] duration-300',
        useCollapsedOffset
          ? 'ml-[var(--sidebar-offset-collapsed)] w-[calc(100%-var(--sidebar-offset-collapsed))]'
          : 'ml-[var(--sidebar-offset)] w-[calc(100%-var(--sidebar-offset))]'
      )}
    >
      <main className="box-border w-full max-w-full overflow-visible px-4 py-4 sm:px-5 lg:px-6">
        <TopBar pathname={pathname} />
        <DemoBanner />
        <AccessGate>
          <div className="animate-slide-up relative z-0 isolate w-full max-w-full">{children}</div>
        </AccessGate>
      </main>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <SessionProvider>
        <div className="mesh-bg min-h-screen">
          <AppSidebar />
          <MainContent>{children}</MainContent>
        </div>
      </SessionProvider>
    </SidebarProvider>
  );
}
