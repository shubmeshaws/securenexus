'use client';

import { TriangleAlert } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';

export function AccessPendingBanner() {
  return (
    <div className="mb-5 flex w-full max-w-full flex-wrap items-start gap-2.5 rounded-xl border border-amber-500/25 bg-gradient-to-r from-amber-500/10 via-orange-500/5 to-transparent px-4 py-3 backdrop-blur-md">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 ring-1 ring-amber-400/25">
        <AppIcon icon={TriangleAlert} size="sm" className="text-amber-600 dark:text-amber-300" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Access pending</p>
        <p className="mt-0.5 text-xs leading-relaxed text-amber-900/80 dark:text-amber-100/80">
          Your account is signed in but not enabled yet. Contact an administrator to grant access.
        </p>
      </div>
    </div>
  );
}
