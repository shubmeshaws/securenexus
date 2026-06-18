'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ICON_STROKE, Icons } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/brand/brand-logo';
import { useSidebar } from './sidebar-context';
import { useSession } from '@/components/auth/session-context';
import { canAccessRoute } from '@/lib/permissions';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: Icons.pages.dashboard },
  { href: '/infrastructure', label: 'Infrastructure', icon: Icons.pages.infrastructure },
  { href: '/clusters', label: 'Clusters', icon: Icons.pages.clusters },
  { href: '/schedules', label: 'Schedules', icon: Icons.pages.schedules },
  { href: '/active-schedules', label: 'Live Schedules', icon: Icons.pages.liveSchedules, liveCount: true },
  { href: '/activity', label: 'Activity Logs', icon: Icons.pages.activity },
  { href: '/resource-audit', label: 'Resource changes', icon: Icons.pages.resourceAudit },
  { href: '/alerts', label: 'Alerts', icon: Icons.pages.alerts },
  { href: '/contact', label: 'Contact', icon: Icons.pages.contact },
  { href: '/admin', label: 'Admin Panel', icon: Icons.pages.admin },
];

export function AppSidebar() {
  const pathname = usePathname();
  const session = useSession();
  const { collapsed, toggle, isMobile, setCollapsed } = useSidebar();
  const expandedOnMobile = isMobile && !collapsed;

  const visibleNavItems = navItems.filter((item) => {
    if (!session) return true;
    if (!session.active) return true;
    return canAccessRoute(session.role, item.href);
  });

  const { data: liveData } = useQuery({
    queryKey: ['schedules-live'],
    queryFn: () => apiFetch<{ total: number }>('/api/schedules/live'),
    refetchInterval: POLL_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  const liveCount = liveData?.total ?? 0;

  return (
    <>
      {expandedOnMobile && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden"
          onClick={() => setCollapsed(true)}
        />
      )}
      <aside
        className={cn(
          'sidebar-shell fixed z-50 flex flex-col transition-all duration-300',
          'top-[var(--sidebar-inset)] bottom-[var(--sidebar-inset)] left-[var(--sidebar-inset)]',
          'rounded-2xl',
          collapsed ? 'w-[var(--sidebar-collapsed)]' : 'w-[var(--sidebar-width)]',
          expandedOnMobile && 'shadow-2xl'
        )}
      >
        <div
          className={cn(
            'flex shrink-0 items-center border-b border-border/60',
            collapsed ? 'justify-center px-2 py-6' : 'px-2 py-6'
          )}
        >
          <BrandLogo collapsed={collapsed} />
        </div>

        <nav
          className={cn(
            'flex-1 space-y-0.5 overflow-y-auto scrollbar-thin',
            collapsed ? 'px-2 py-1' : 'px-3 py-1'
          )}
        >
          {visibleNavItems.map(({ href, label, icon: Icon, liveCount: showLiveCount }) => {
            const active =
              href === '/dashboard'
                ? pathname === href || (pathname?.startsWith(`${href}/`) ?? false)
                : (pathname?.startsWith(href) ?? false);
            const badgeCount = showLiveCount ? liveCount : 0;
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={cn(
                  'relative flex items-center rounded-xl transition-all duration-200 group',
                  collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5',
                  active
                    ? collapsed
                      ? 'nav-item-active-collapsed'
                      : 'nav-item-active text-foreground'
                    : 'text-zinc-600 hover:bg-zinc-100 hover:text-foreground dark:text-muted-foreground dark:hover:bg-accent/80'
                )}
              >
                <div
                  className={cn(
                    'relative flex shrink-0 items-center justify-center rounded-lg transition-all duration-200',
                    collapsed ? 'h-8 w-8' : 'h-8 w-8',
                    active
                      ? collapsed
                        ? 'bg-blue-500 text-white shadow-md shadow-blue-500/25'
                        : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/80 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/20'
                      : 'bg-zinc-100 text-zinc-600 group-hover:bg-blue-50 group-hover:text-blue-700 dark:bg-secondary/80 dark:text-muted-foreground dark:group-hover:bg-blue-500/10 dark:group-hover:text-blue-300'
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={ICON_STROKE} />
                  {badgeCount > 0 && collapsed && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white ring-2 ring-card">
                      {badgeCount > 9 ? '9+' : badgeCount}
                    </span>
                  )}
                </div>
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
                    {badgeCount > 0 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-700 dark:text-red-400">
                        {badgeCount}
                      </span>
                    )}
                  </>
                )}
              </Link>
            );
          })}
        </nav>

        {!collapsed && (
          <div className="mx-3 mb-2 rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                All systems operational
              </span>
            </div>
          </div>
        )}

        <div className={cn('shrink-0', collapsed ? 'p-2 pb-3' : 'p-3')}>
          <button
            type="button"
            onClick={toggle}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-xl border border-border/60 bg-secondary/40 text-xs font-medium text-muted-foreground transition-all hover:border-blue-500/25 hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-300',
              collapsed ? 'px-0 py-2.5' : 'px-3 py-2.5'
            )}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" strokeWidth={ICON_STROKE} />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4" strokeWidth={ICON_STROKE} />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </>
  );
}
