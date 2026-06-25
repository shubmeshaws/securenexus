'use client';

import { cn } from '@/lib/utils';

export type ScheduleStatusCountKey = 'enabled' | 'stopped' | 'disabled' | 'completed';

const STATUS_META: Record<
  ScheduleStatusCountKey | 'total',
  { label: string; chip: string; dot: string }
> = {
  total: {
    label: 'Total',
    chip: 'bg-slate-500/10 text-slate-700 ring-1 ring-slate-500/20 dark:text-slate-300',
    dot: 'bg-slate-500',
  },
  enabled: {
    label: 'Enabled',
    chip: 'bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
  stopped: {
    label: 'Stopped',
    chip: 'bg-red-500/10 text-red-700 ring-1 ring-red-500/25 dark:text-red-300',
    dot: 'bg-red-500',
  },
  disabled: {
    label: 'Disabled',
    chip: 'bg-zinc-500/10 text-zinc-600 ring-1 ring-zinc-500/20 dark:text-zinc-400',
    dot: 'bg-zinc-400',
  },
  completed: {
    label: 'Completed',
    chip: 'bg-violet-500/10 text-violet-700 ring-1 ring-violet-500/25 dark:text-violet-300',
    dot: 'bg-violet-500',
  },
};

const STATUS_ORDER: (ScheduleStatusCountKey | 'total')[] = [
  'total',
  'enabled',
  'stopped',
  'disabled',
  'completed',
];

function countByStatus<T>(
  items: T[],
  getStatusKey: (item: T) => ScheduleStatusCountKey
): Record<ScheduleStatusCountKey, number> {
  const counts: Record<ScheduleStatusCountKey, number> = {
    enabled: 0,
    stopped: 0,
    disabled: 0,
    completed: 0,
  };
  for (const item of items) {
    counts[getStatusKey(item)] += 1;
  }
  return counts;
}

function CountChip({
  label,
  count,
  denominator,
  chipClass,
  dotClass,
}: {
  label: string;
  count: number;
  denominator?: number;
  chipClass: string;
  dotClass: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none',
        chipClass
      )}
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)} aria-hidden />
      <span>{label}</span>
      <span className="tabular-nums font-semibold">
        {count}
        {denominator != null && count !== denominator ? (
          <span className="font-normal opacity-70">/{denominator}</span>
        ) : null}
      </span>
    </span>
  );
}

export function ScheduleStatusCountBar<T>({
  filteredItems,
  allItems,
  getStatusKey,
  filtersActive = false,
  className,
}: {
  filteredItems: T[];
  allItems: T[];
  getStatusKey: (item: T) => ScheduleStatusCountKey;
  filtersActive?: boolean;
  className?: string;
}) {
  const filteredCounts = countByStatus(filteredItems, getStatusKey);
  const allCounts = countByStatus(allItems, getStatusKey);

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {STATUS_ORDER.map((key) => {
        const meta = STATUS_META[key];
        const count = key === 'total' ? filteredItems.length : filteredCounts[key];
        const denominator =
          filtersActive && key === 'total'
            ? allItems.length
            : filtersActive && key !== 'total'
              ? allCounts[key]
              : undefined;

        if (key !== 'total' && count === 0 && !filtersActive) return null;

        return (
          <CountChip
            key={key}
            label={meta.label}
            count={count}
            denominator={denominator}
            chipClass={meta.chip}
            dotClass={meta.dot}
          />
        );
      })}
      {filtersActive ? (
        <span className="text-[10px] text-muted-foreground">
          Counts reflect current search &amp; filters
        </span>
      ) : null}
    </div>
  );
}
