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
  columns?: 2 | 3;
}) {
  return (
    <div
      className={cn(
        'mt-4 grid gap-6 border-t border-border/50 pt-5',
        columns === 2 ? 'grid-cols-2' : 'grid-cols-3'
      )}
    >
      {children}
    </div>
  );
}
