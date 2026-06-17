'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Filler,
  Tooltip,
  type ChartOptions,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import { ArrowUp, TrendingUp } from 'lucide-react';
import { useTheme } from '@/components/providers/theme-provider';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  getClusterChartStyle,
  COST_SAVINGS_TREND_PLACEHOLDER,
  formatSavingsUsd,
  type CostSavingsTrendResponse,
} from '@/lib/cost-savings-trend-data';
import {
  appendDashboardDateQuery,
  getDashboardPeriodLabel,
  isDashboardDateRangeReady,
  type DashboardDateRange,
} from '@/lib/dashboard-date-range';
import { cn } from '@/lib/utils';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Filler,
  Tooltip
);

type ChartMode = 'line' | 'bar';

const CHART_HEIGHT_PX = 260;

function clusterStyle(clusterId: string) {
  return getClusterChartStyle(clusterId);
}

function ChartToggle({
  chartMode,
  onChange,
}: {
  chartMode: ChartMode;
  onChange: (mode: ChartMode) => void;
}) {
  return (
    <div className="flex shrink-0 rounded-lg bg-muted p-0.5">
      {(['line', 'bar'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[10px] capitalize transition-colors',
            chartMode === mode
              ? 'border border-border bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function CostSavingsTrendSkeleton() {
  return (
    <GlassPanel className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-7 w-28 rounded-lg" />
      </div>
      <Skeleton className="mx-5 mt-3 h-3 w-56" />
      <div className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex gap-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="w-full flex-1 rounded-xl" style={{ minHeight: CHART_HEIGHT_PX }} />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    </GlassPanel>
  );
}

export default function CostSavingsTrend({
  className,
  dateRange,
}: {
  className?: string;
  dateRange: DashboardDateRange;
}) {
  const { theme } = useTheme();
  const [chartMode, setChartMode] = useState<ChartMode>('bar');

  const trendUrl = appendDashboardDateQuery('/api/dashboard/cost-trend', dateRange);
  const rangeReady = isDashboardDateRangeReady(dateRange);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['cost-savings-trend', dateRange],
    queryFn: () => apiFetch<CostSavingsTrendResponse>(trendUrl),
    refetchInterval: 60_000,
    placeholderData: (previousData) => previousData ?? COST_SAVINGS_TREND_PLACEHOLDER,
    enabled: rangeReady,
  });

  const chartData = data ?? COST_SAVINGS_TREND_PLACEHOLDER;
  const isDark = theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tickColor = '#888780';

  const datasets = useMemo(() => {
    return chartData.clusters.map((cluster) => {
      const style = clusterStyle(cluster.id);
      if (chartMode === 'line') {
        return {
          label: cluster.id,
          data: cluster.data,
          borderColor: style.color,
          backgroundColor: style.fill,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          borderDash: style.dashed ? ([4, 3] as number[]) : ([] as number[]),
          fill: true,
        };
      }
      return {
        label: cluster.id,
        data: cluster.data,
        backgroundColor: style.barBg,
        borderColor: style.color,
        borderWidth: 1,
        borderRadius: 4,
      };
    });
  }, [chartData.clusters, chartMode]);

  const options: ChartOptions<'line' | 'bar'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => ` ${formatSavingsUsd(Number(context.parsed.y))} saved`,
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: chartMode === 'bar' ? false : true,
            color: gridColor,
          },
          ticks: {
            color: tickColor,
            font: { size: 10 },
            maxTicksLimit: chartData.days > 14 ? 8 : 7,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: gridColor },
          ticks: {
            color: tickColor,
            font: { size: 10 },
            callback: (value) => formatSavingsUsd(Number(value)),
          },
        },
      },
    }),
    [chartMode, chartData.days, gridColor, tickColor]
  );

  if (isLoading && !data) {
    return <CostSavingsTrendSkeleton />;
  }

  const ChartComponent = chartMode === 'line' ? Line : Bar;
  const periodLabel = getDashboardPeriodLabel(dateRange);

  return (
    <GlassPanel className={cn('flex h-full flex-col', className)}>
      <PanelHeader
        title="Cost savings trend"
        icon={TrendingUp}
        accent="violet"
        action={
          <div className="flex h-8 items-center">
            <ChartToggle chartMode={chartMode} onChange={setChartMode} />
          </div>
        }
      />
      <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
        Estimated daily savings from logged stop→start windows · {periodLabel}
        {isFetching ? ' · updating…' : ''}
      </p>

      <div className="flex flex-1 flex-col px-5 py-3">
        <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5">
          {chartData.clusters.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No estimated savings in this period — run schedules or check activity logs.
            </p>
          ) : (
            chartData.clusters.map((cluster) => {
              const style = clusterStyle(cluster.id);
              return (
                <div key={cluster.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: style.color }}
                  />
                  <span>
                    {cluster.id} · {formatSavingsUsd(cluster.total)}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="relative w-full shrink-0" style={{ height: CHART_HEIGHT_PX }}>
          {!rangeReady ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Select a from and to date to load the chart.
            </div>
          ) : chartData.clusters.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No cost savings data for the selected range.
            </div>
          ) : (
            <ChartComponent data={{ labels: chartData.labels, datasets }} options={options} />
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2.5">
          <div className="text-[11px]">
            <span className="text-muted-foreground">Today: </span>
            <span className="font-medium text-foreground">{formatSavingsUsd(chartData.summary.today)}</span>
          </div>
          <div className="text-[11px]">
            <span className="text-muted-foreground">Period total: </span>
            <span className="font-medium text-foreground">{formatSavingsUsd(chartData.summary.thisMonth)}</span>
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-muted-foreground">vs prior period: </span>
            <span
              className={cn(
                'inline-flex items-center gap-0.5 font-medium',
                chartData.summary.lastMonthDelta >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              )}
            >
              {chartData.summary.lastMonthDelta >= 0 ? (
                <ArrowUp className="h-3 w-3" strokeWidth={2} />
              ) : (
                <ArrowUp className="h-3 w-3 rotate-180" strokeWidth={2} />
              )}
              {formatSavingsUsd(Math.abs(chartData.summary.lastMonthDelta))}
            </span>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}
