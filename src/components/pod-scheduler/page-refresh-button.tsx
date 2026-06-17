'use client';

import { useMemo, useState } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getPageRefreshQueryKeys,
  queryMatchesRefreshKeys,
} from '@/lib/page-refresh';

export function PageRefreshButton({ className }: { className?: string }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const refreshKeys = useMemo(() => getPageRefreshQueryKeys(pathname), [pathname]);

  const isFetchingPage = useIsFetching({
    predicate: (query) => queryMatchesRefreshKeys(query.queryKey, refreshKeys),
  });

  const spinning = pending || isFetchingPage > 0;

  async function handleRefresh() {
    if (!refreshKeys.length || spinning) return;
    setPending(true);
    try {
      await Promise.all(
        refreshKeys.map((queryKey) =>
          queryClient.refetchQueries({ queryKey: [...queryKey], type: 'active' })
        )
      );
    } finally {
      setPending(false);
    }
  }

  if (!refreshKeys.length) return null;

  return (
    <button
      type="button"
      onClick={() => void handleRefresh()}
      disabled={spinning}
      aria-label="Refresh page data"
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60',
        className
      )}
    >
      <RefreshCw className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} strokeWidth={2} />
      <span className="hidden sm:inline">Refresh</span>
    </button>
  );
}
