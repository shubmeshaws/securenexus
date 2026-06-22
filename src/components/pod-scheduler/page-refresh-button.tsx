'use client';

import { useMemo, useState } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/ui/app-icon';
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
    <Button
      type="button"
      size="sm"
      variant="warning"
      onClick={() => void handleRefresh()}
      disabled={spinning}
      aria-label="Refresh page data"
      className={cn('shrink-0', className)}
    >
      <AppIcon
        icon={RefreshCw}
        size="sm"
        className={cn(spinning && 'animate-spin')}
      />
      Refresh
    </Button>
  );
}
