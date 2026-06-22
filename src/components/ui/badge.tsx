import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-blue-500/30 bg-blue-500/15 text-blue-700 dark:text-blue-300',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        synced: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        outOfSync: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        unknown: 'border-border bg-muted text-muted-foreground',
        progressing: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
        automated: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
        manual: 'border-border bg-muted text-muted-foreground',
        replicas: 'border-border bg-secondary text-foreground font-mono',
        success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        failed: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
        successSolid: 'border-0 bg-emerald-500 text-white shadow-sm',
        manualStopSolid: 'border-0 bg-amber-500 text-white shadow-sm',
        failedSolid: 'border-0 bg-red-500 text-white shadow-sm',
        neutralSolid: 'border-0 bg-zinc-500 text-white shadow-sm dark:bg-zinc-600',
        completedSolid: 'border-0 bg-violet-600 text-white shadow-sm',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
