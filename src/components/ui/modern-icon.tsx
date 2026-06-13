import type { LucideIcon } from 'lucide-react';
import { ICON_STROKE } from '@/lib/icons';
import { cn } from '@/lib/utils';

export type IconAccent = 'blue' | 'emerald' | 'amber' | 'red' | 'sky' | 'violet' | 'slate';

const ACCENT_STYLES: Record<
  IconAccent,
  { box: string; icon: string; glow: string }
> = {
  blue: {
    box: 'bg-blue-50 ring-blue-200/90 dark:bg-blue-500/15 dark:ring-blue-400/20',
    icon: 'text-blue-700 dark:text-blue-400',
    glow: 'bg-blue-400/30 dark:bg-blue-400/25',
  },
  emerald: {
    box: 'bg-emerald-50 ring-emerald-200/90 dark:bg-emerald-500/15 dark:ring-emerald-400/20',
    icon: 'text-emerald-700 dark:text-emerald-400',
    glow: 'bg-emerald-400/30 dark:bg-emerald-400/25',
  },
  amber: {
    box: 'bg-amber-50 ring-amber-200/90 dark:bg-amber-500/15 dark:ring-amber-400/20',
    icon: 'text-amber-700 dark:text-amber-400',
    glow: 'bg-amber-400/30 dark:bg-amber-400/25',
  },
  red: {
    box: 'bg-red-50 ring-red-200/90 dark:bg-red-500/15 dark:ring-red-400/20',
    icon: 'text-red-700 dark:text-red-400',
    glow: 'bg-red-400/30 dark:bg-red-400/25',
  },
  sky: {
    box: 'bg-sky-50 ring-sky-200/90 dark:bg-sky-500/15 dark:ring-sky-400/20',
    icon: 'text-sky-700 dark:text-sky-400',
    glow: 'bg-sky-400/30 dark:bg-sky-400/25',
  },
  violet: {
    box: 'bg-violet-50 ring-violet-200/90 dark:bg-violet-500/15 dark:ring-violet-400/20',
    icon: 'text-violet-700 dark:text-violet-400',
    glow: 'bg-violet-400/30 dark:bg-violet-400/25',
  },
  slate: {
    box: 'bg-slate-100 ring-slate-300/90 dark:bg-slate-500/15 dark:ring-slate-400/20',
    icon: 'text-slate-700 dark:text-slate-300',
    glow: 'bg-slate-400/25 dark:bg-slate-400/20',
  },
};

const SIZES = {
  sm: { box: 'h-8 w-8 rounded-xl', icon: 'h-4 w-4' },
  md: { box: 'h-10 w-10 rounded-2xl', icon: 'h-[18px] w-[18px]' },
  lg: { box: 'h-12 w-12 rounded-2xl', icon: 'h-5 w-5' },
} as const;

export function ModernIcon({
  icon: Icon,
  accent = 'blue',
  size = 'md',
  className,
  glow = false,
}: {
  icon: LucideIcon;
  accent?: IconAccent;
  size?: keyof typeof SIZES;
  className?: string;
  glow?: boolean;
}) {
  const palette = ACCENT_STYLES[accent];
  const dim = SIZES[size];

  return (
    <div className={cn('relative shrink-0', className)}>
      {glow && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 scale-150 rounded-full opacity-40 blur-xl dark:opacity-60',
            palette.glow
          )}
        />
      )}
      <div
        className={cn(
          'relative flex items-center justify-center ring-1 ring-inset transition-transform duration-300',
          dim.box,
          palette.box
        )}
      >
        <Icon
          className={cn(dim.icon, palette.icon)}
          strokeWidth={ICON_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          absoluteStrokeWidth
        />
      </div>
    </div>
  );
}
