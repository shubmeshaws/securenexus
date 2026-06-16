'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  BellRing,
  ChevronRight,
  CircleAlert,
  Info,
  Command,
  ICON_STROKE,
  LogOut,
  ScanSearch,
  Settings2,
  Sparkles,
  TriangleAlert,
  X,
} from '@/lib/icons';
import { ThemeToggle } from '@/components/pod-scheduler/theme-toggle';
import { apiFetch } from '@/lib/api-client';
import { getPageMeta } from '@/lib/page-meta';
import {
  PAGE_SEARCH_ITEMS,
  buildDynamicSearchResults,
  filterSearchResults,
  categoryLabel,
  type SearchResult,
} from '@/lib/search-index';
import { canAccessRoute, isAdminRole } from '@/lib/permissions';
import { useSession } from '@/components/auth/session-context';
import type { AppNotification, NotificationType } from '@/lib/notifications';
import { cn, formatRelativeTime } from '@/lib/utils';
import { ModernIcon } from '@/components/ui/modern-icon';
import { Input } from '@/components/ui/input';

const NOTIF_ICON = {
  success: BadgeCheck,
  warning: TriangleAlert,
  info: Info,
  error: CircleAlert,
};

const NOTIF_STYLE = {
  success: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  warning: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
  info: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/20',
  error: 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20',
};

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void, enabled: boolean) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [ref, enabled]);
}

export function TopBar({ pathname }: { pathname: string | null }) {
  const router = useRouter();
  const pageMeta = getPageMeta(pathname);
  const PageIcon = pageMeta.icon;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const readIdsLoadedRef = useRef(false);

  const notifRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const closeNotif = useCallback(() => setNotifOpen(false), []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);

  useClickOutside(notifRef, closeNotif, notifOpen);
  useClickOutside(profileRef, closeProfile, profileOpen);

  const session = useSession();

  const { data: notificationsData } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiFetch<{ notifications: AppNotification[]; unread: number }>('/api/notifications'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchIntervalInBackground: false,
  });

  const { data: searchData } = useQuery({
    queryKey: ['global-search-data'],
    queryFn: async () => {
      const [clusters, schedules, activity, users, infra] = await Promise.all([
        apiFetch<{ clusters: { id: string; name: string; provider: string; status: string }[] }>('/api/clusters/registry').catch(() => ({ clusters: [] })),
        apiFetch<{ schedules: { id: string; name: string; cluster: string; appName: string }[] }>('/api/schedules').catch(() => ({ schedules: [] })),
        apiFetch<{ logs: { id: string; action: string; cluster: string; appName: string; triggeredBy: string }[] }>('/api/schedules/activity').catch(() => ({ logs: [] })),
        apiFetch<{ users: { id: string; displayName: string; email: string; role: string }[] }>('/api/admin/users').catch(() => ({ users: [] })),
        apiFetch<{ clusters: { id: string; name: string; infraState: string }[] }>('/api/infrastructure/overview').catch(() => ({ clusters: [] })),
      ]);
      return { clusters, schedules, activity, users, infra };
    },
    enabled: searchOpen,
    staleTime: 60_000,
  });

  const allSearchItems = useMemo(() => {
    const pageItems = PAGE_SEARCH_ITEMS.filter((item) => {
      if (!session?.active) return item.href === '/dashboard';
      return canAccessRoute(session.role, item.href);
    });
    if (!searchData) return pageItems;
    const dynamic = buildDynamicSearchResults({
      clusters: searchData.clusters?.clusters ?? [],
      schedules: searchData.schedules?.schedules ?? [],
      activity: searchData.activity?.logs ?? [],
      users: isAdminRole(session?.role ?? '') ? searchData.users?.users ?? [] : [],
      infraClusters: searchData.infra?.clusters ?? [],
    });
    return [...pageItems, ...dynamic];
  }, [searchData, session?.active, session?.role]);

  const searchResults = useMemo(
    () => filterSearchResults(allSearchItems, searchQuery),
    [allSearchItems, searchQuery]
  );

  const notifications = notificationsData?.notifications ?? [];
  const unreadCount = notifications.filter((n) => !readIds.has(n.id)).length;

  const markAllNotificationsRead = useCallback(() => {
    if (notifications.length === 0) return;
    setReadIds((prev) => {
      const next = new Set(prev);
      notifications.forEach((n) => next.add(n.id));
      return next;
    });
  }, [notifications]);

  useEffect(() => {
    if (readIdsLoadedRef.current) return;
    readIdsLoadedRef.current = true;
    try {
      const raw = localStorage.getItem('sn_notification_reads');
      if (raw) {
        const ids = JSON.parse(raw) as string[];
        if (Array.isArray(ids)) setReadIds(new Set(ids));
      }
    } catch {
      // ignore corrupt storage
    }
  }, []);

  useEffect(() => {
    if (readIds.size === 0) return;
    localStorage.setItem('sn_notification_reads', JSON.stringify(Array.from(readIds)));
  }, [readIds]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      localStorage.removeItem('sn_token');
      router.push('/login');
    } catch {
      router.push('/login');
    }
  };

  const handleSearchSelect = (item: SearchResult) => {
    setSearchOpen(false);
    setSearchQuery('');
    router.push(item.href);
  };

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setNotifOpen(false);
    setProfileOpen(false);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openSearch();
      }
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setNotifOpen(false);
        setProfileOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [searchOpen]);

  const initials = session?.initials ?? 'SN';

  return (
    <>
      <header className="top-bar relative z-50 mb-5 flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <ModernIcon icon={PageIcon} accent={pageMeta.accent} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-500 dark:text-muted-foreground">
              <Sparkles className="h-3 w-3 text-blue-600 dark:text-blue-400" strokeWidth={ICON_STROKE} />
              <span>SecureNexus</span>
              <ChevronRight className="h-3 w-3 opacity-50" strokeWidth={2} />
              <span className="text-foreground/80">{pageMeta.title}</span>
            </div>
            <p className="truncate font-display text-sm font-semibold tracking-tight text-foreground sm:text-base">
              {pageMeta.subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-2.5">
          <button
            type="button"
            onClick={openSearch}
            className="header-search-pill hidden md:flex"
            aria-label="Open search"
          >
            <ScanSearch className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={ICON_STROKE} />
            <span className="text-xs text-muted-foreground">Search workspace…</span>
            <span className="ml-auto flex items-center gap-1 rounded-md border border-border bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Command className="h-3 w-3" strokeWidth={2} />
              K
            </span>
          </button>

          <button
            type="button"
            className="header-icon-btn md:hidden"
            aria-label="Search"
            onClick={openSearch}
          >
            <ScanSearch className="h-4 w-4" strokeWidth={ICON_STROKE} />
          </button>

          <div className="header-toolbar">
            <ThemeToggle />
            <div className="relative" ref={notifRef}>
              <button
                type="button"
                className="header-icon-btn relative"
                aria-label="Notifications"
                onClick={() => {
                  setNotifOpen((wasOpen) => {
                    if (!wasOpen) markAllNotificationsRead();
                    return !wasOpen;
                  });
                  setProfileOpen(false);
                }}
              >
                <BellRing className="h-4 w-4" strokeWidth={ICON_STROKE} />
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-bold text-white ring-2 ring-card">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="topbar-dropdown absolute right-0 top-full z-[100] mt-2 w-80 sm:w-96">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-semibold text-foreground">Notifications</p>
                    <p className="text-xs text-muted-foreground">
                      {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
                    </p>
                  </div>
                  <div className="max-h-80 overflow-y-auto scrollbar-thin p-2">
                    {notifications.length === 0 ? (
                      <p className="px-3 py-6 text-center text-xs text-muted-foreground">No notifications</p>
                    ) : (
                      notifications.map((n) => {
                        const type = n.type in NOTIF_ICON ? n.type : 'info';
                        const Icon = NOTIF_ICON[type as NotificationType];
                        const isRead = readIds.has(n.id);
                        return (
                          <button
                            key={n.id}
                            type="button"
                            onClick={() => {
                              setReadIds((prev) => new Set(prev).add(n.id));
                            }}
                            className={cn(
                              'mb-1.5 flex w-full gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent/60',
                              isRead ? 'border-border/60 bg-transparent opacity-75' : 'border-blue-500/15 bg-blue-500/5'
                            )}
                          >
                            <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border', NOTIF_STYLE[type as NotificationType])}>
                              <Icon className="h-4 w-4" strokeWidth={ICON_STROKE} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-foreground">{n.title}</p>
                              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{n.message}</p>
                              <p className="mt-1 text-[10px] text-muted-foreground/70">{formatRelativeTime(n.timestamp)}</p>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="relative" ref={profileRef}>
              <button
                type="button"
                aria-label="Profile menu"
                onClick={() => {
                  setProfileOpen((o) => !o);
                  setNotifOpen(false);
                }}
                className="header-avatar-btn"
              >
                <span className="header-avatar-ring">
                  <span className="flex h-full w-full items-center justify-center rounded-[10px] bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-600 text-[10px] font-bold text-white">
                    {initials}
                  </span>
                </span>
              </button>

              {profileOpen && (
                <div className="topbar-dropdown absolute right-0 top-full z-[100] mt-2 w-56">
                  <div className="border-b border-border px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white shadow-md">
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {session?.displayName ?? session?.email?.split('@')[0] ?? 'User'}
                        </p>
                        <p className="truncate text-[10px] capitalize text-muted-foreground">
                          {session?.role ?? 'member'} · {session?.email ?? 'Signed in'}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="p-1.5">
                    {session?.active && isAdminRole(session.role) && (
                      <button
                        type="button"
                        className="header-menu-item"
                        onClick={() => {
                          setProfileOpen(false);
                          router.push('/admin');
                        }}
                      >
                        <Settings2 className="h-4 w-4 text-blue-500/80" strokeWidth={ICON_STROKE} />
                        Admin settings
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={loggingOut}
                      className="header-menu-item text-red-600 hover:bg-red-500/10 dark:text-red-400"
                      onClick={handleLogout}
                    >
                      <LogOut className="h-4 w-4" strokeWidth={ICON_STROKE} />
                      {loggingOut ? 'Logging out…' : 'Logout'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {searchOpen && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm">
          <div className="w-full max-w-lg animate-slide-up rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <ScanSearch className="h-4 w-4 shrink-0 text-blue-500/80" strokeWidth={ICON_STROKE} />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search pages, clusters, schedules, activity…"
                className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              />
              <button
                type="button"
                onClick={() => { setSearchOpen(false); setSearchQuery(''); }}
                className="header-icon-btn h-8 w-8"
              >
                <X className="h-4 w-4" strokeWidth={ICON_STROKE} />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto scrollbar-thin p-2">
              {searchResults.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No results for &ldquo;{searchQuery}&rdquo;
                </p>
              ) : (
                searchResults.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSearchSelect(item)}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-secondary to-secondary/40 ring-1 ring-border">
                        <Icon className="h-4 w-4 text-blue-600 dark:text-blue-400" strokeWidth={ICON_STROKE} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-foreground">{item.title}</p>
                        <p className="truncate text-[10px] text-muted-foreground">{item.subtitle}</p>
                      </div>
                      <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                        {categoryLabel(item.category)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="border-t border-border px-4 py-2">
              <p className="text-[10px] text-muted-foreground">
                <kbd className="rounded border border-border bg-secondary px-1">⌘K</kbd> to search anywhere
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
