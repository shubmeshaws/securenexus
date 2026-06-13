'use client';

import { TriangleAlert } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';

interface DegradedBannerProps {
  message?: string;
  title: string;
}

export function DegradedBanner({ message, title }: DegradedBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-500/15">
        <AppIcon icon={TriangleAlert} className="text-amber-600 dark:text-amber-400" />
      </div>
      <div>
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{title}</p>
        {message && (
          <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-200/70">{message}</p>
        )}
      </div>
    </div>
  );
}
