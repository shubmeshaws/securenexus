import { cn, formatStoppedDuration } from '@/lib/utils';

type StoppedDurationBarAccent = 'red' | 'amber';

const BAR_FILL: Record<StoppedDurationBarAccent, string> = {
  red: 'bg-gradient-to-r from-red-500/90 to-red-400/70',
  amber: 'bg-gradient-to-r from-amber-500/90 to-amber-400/70',
};

export function StoppedDurationBar({
  stoppedMs,
  maxMs,
  accent = 'red',
  className,
  barOnly = false,
}: {
  stoppedMs: number;
  maxMs: number;
  accent?: StoppedDurationBarAccent;
  className?: string;
  /** When true, renders only the progress track (label goes in Stopped time column). */
  barOnly?: boolean;
}) {
  const pct = maxMs > 0 ? Math.min(100, Math.round((stoppedMs / maxMs) * 100)) : 0;

  return (
    <div className={cn(barOnly ? 'w-full min-w-[5rem]' : 'min-w-[6.5rem]', className)}>
      {!barOnly && (
        <div className="mb-1.5 flex items-center justify-end">
          <span className="text-xs font-medium tabular-nums text-foreground">
            {formatStoppedDuration(stoppedMs)}
          </span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/80 ring-1 ring-inset ring-border/40">
        <div
          className={cn('h-full rounded-full transition-[width] duration-500 ease-out', BAR_FILL[accent])}
          style={{ width: `${Math.max(pct, stoppedMs > 0 ? 4 : 0)}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${formatStoppedDuration(stoppedMs)} stopped`}
        />
      </div>
    </div>
  );
}
