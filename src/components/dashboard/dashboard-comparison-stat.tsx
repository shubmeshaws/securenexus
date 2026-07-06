import { cn } from '@/lib/utils';

export function DashboardComparisonStat({
  color,
  label,
  value,
  dotShape = 'round',
}: {
  color: string;
  label: string;
  value: string | number;
  dotShape?: 'round' | 'square';
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          className={cn(
            'inline-block h-2.5 w-2.5',
            dotShape === 'round' ? 'rounded-full' : 'rounded-sm'
          )}
          style={{ backgroundColor: color }}
        />
        <span>{label}</span>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
    </div>
  );
}

export function DashboardChartComparisonFooter({
  children,
  columns = 2,
}: {
  children: React.ReactNode;
  columns?: 2 | 3 | 4 | 5 | 6 | 7;
}) {
  const gridClass =
    columns === 2
      ? 'grid-cols-2'
      : columns === 3
        ? 'grid-cols-3'
        : columns === 4
          ? 'grid-cols-2 sm:grid-cols-4'
          : columns === 5
            ? 'grid-cols-2 sm:grid-cols-5'
            : columns === 6
              ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
              : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-7';

  return (
    <div className={cn('mt-4 grid gap-4 border-t border-border/50 pt-5 sm:gap-6', gridClass)}>
      {children}
    </div>
  );
}
