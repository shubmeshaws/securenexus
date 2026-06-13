'use client';

import { isDemoMode } from '@/lib/api-client';
import { Info } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';

export function DemoBanner() {
  if (!isDemoMode()) return null;

  return (
    <div className="mb-5 flex w-full max-w-full flex-wrap items-start gap-2.5 rounded-xl border border-blue-500/20 bg-gradient-to-r from-blue-600/10 via-sky-600/5 to-transparent px-3 py-2 backdrop-blur-md">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 ring-1 ring-blue-400/25">
        <AppIcon icon={Info} size="sm" className="text-blue-500 dark:text-blue-300" />
      </div>
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-blue-600 dark:text-blue-300">Demo mode</span>
        {' '}— previewing sample data. Disable in{' '}
        <strong className="text-blue-600 dark:text-blue-300">Admin → Settings</strong>{' '}
        for live data.
      </p>
    </div>
  );
}
