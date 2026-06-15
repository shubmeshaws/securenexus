import { cn } from '@/lib/utils';
import type { IconAccent } from '@/components/ui/modern-icon';

const ACCENT_BOX: Record<IconAccent, string> = {
  blue: 'bg-blue-50 ring-blue-200/90 dark:bg-blue-500/15 dark:ring-blue-400/20',
  emerald: 'bg-emerald-50 ring-emerald-200/90 dark:bg-emerald-500/15 dark:ring-emerald-400/20',
  amber: 'bg-amber-50 ring-amber-200/90 dark:bg-amber-500/15 dark:ring-amber-400/20',
  red: 'bg-red-50 ring-red-200/90 dark:bg-red-500/15 dark:ring-red-400/20',
  sky: 'bg-sky-50 ring-sky-200/90 dark:bg-sky-500/15 dark:ring-sky-400/20',
  violet: 'bg-violet-50 ring-violet-200/90 dark:bg-violet-500/15 dark:ring-violet-400/20',
  slate: 'bg-slate-100 ring-slate-300/90 dark:bg-slate-500/15 dark:ring-slate-400/20',
};

const SIZES = {
  sm: { box: 'h-8 w-8 rounded-xl', icon: 18 },
  md: { box: 'h-10 w-10 rounded-2xl', icon: 22 },
  lg: { box: 'h-12 w-12 rounded-2xl', icon: 26 },
} as const;

/** White surface for wordmark logos (AWS) — readable in light and dark mode. */
const SURFACE: Record<'default' | 'light', string> = {
  default: '',
  light: 'bg-white ring-zinc-200/90 dark:bg-white dark:ring-zinc-300/50',
};

export function BrandIcon({
  src,
  alt,
  accent = 'blue',
  size = 'sm',
  surface = 'default',
  className,
}: {
  src: string;
  alt: string;
  accent?: IconAccent;
  size?: keyof typeof SIZES;
  surface?: keyof typeof SURFACE;
  className?: string;
}) {
  const dim = SIZES[surface === 'light' && size === 'sm' ? 'md' : size];
  const iconPx = surface === 'light' && size === 'sm' ? 24 : dim.icon;

  return (
    <div
      role="img"
      aria-label={alt}
      className={cn(
        'relative flex shrink-0 items-center justify-center ring-1 ring-inset',
        dim.box,
        surface === 'light' ? SURFACE.light : ACCENT_BOX[accent],
        className
      )}
    >
      <img
        src={src}
        alt=""
        aria-hidden
        width={iconPx}
        height={iconPx}
        className="object-contain"
        draggable={false}
      />
    </div>
  );
}
