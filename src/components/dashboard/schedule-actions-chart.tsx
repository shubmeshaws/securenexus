'use client';

import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  type ChartOptions,
  type ChartEvent,
  type ActiveElement,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { BarChart2 } from 'lucide-react';
import { useTheme } from '@/components/providers/theme-provider';
import { GlassPanel, PanelHeader, PanelSubtitle } from '@/components/pod-scheduler/ui-primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  getScheduleActionsPlaceholder,
  SCHEDULE_ACTIONS_PLACEHOLDER,
  type ScheduleActionsChartResponse,
} from '@/lib/dashboard-schedule-actions';
import {
  appendDashboardDateQuery,
  getDashboardPeriodLabel,
  isDashboardDateRangeReady,
  type DashboardDateRange,
} from '@/lib/dashboard-date-range';
import { DashboardChartToolbar } from '@/components/dashboard/dashboard-filters';
import {
  DashboardChartComparisonFooter,
  DashboardComparisonStat,
} from '@/components/dashboard/dashboard-comparison-stat';
import { cn } from '@/lib/utils';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

const SHUTDOWN_BAR = {
  fill: 'rgba(239, 68, 68, 0.88)',
  border: '#dc2626',
  legend: '#ef4444',
} as const;

const STARTUP_BAR = {
  fill: 'rgba(234, 179, 8, 0.88)',
  border: '#ca8a04',
  legend: '#eab308',
} as const;

const TOTAL_BAR = {
  legend: '#888780',
} as const;

const CHART_HEIGHT_PX = 260;

function ScheduleActionsChartSkeleton() {
  return (
    <GlassPanel className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="flex h-10 items-center justify-end border-b border-border/60 px-5">
        <Skeleton className="h-6 w-20 rounded-md" />
      </div>
      <div className="border-b border-border px-5 pb-3 pt-0">
        <Skeleton className="h-3 w-52" />
      </div>
      <div className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex gap-4">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="w-full rounded-xl" style={{ height: CHART_HEIGHT_PX }} />
        <div className="grid grid-cols-3 gap-6 px-8">
          <Skeleton className="mx-auto h-12 w-24" />
          <Skeleton className="mx-auto h-12 w-24" />
          <Skeleton className="mx-auto h-12 w-24" />
        </div>
      </div>
    </GlassPanel>
  );
}

export default function ScheduleActionsChart({
  className,
  dateRange,
}: {
  className?: string;
  dateRange: DashboardDateRange;
}) {
  const { theme } = useTheme();
  const router = useRouter();

  const actionsUrl = appendDashboardDateQuery('/api/dashboard/schedule-actions', dateRange);
  const rangeReady = isDashboardDateRangeReady(dateRange);
  const placeholderDays =
    dateRange.preset === 'custom' ? 14 : Number(dateRange.preset);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['schedule-actions', dateRange],
    queryFn: () => apiFetch<ScheduleActionsChartResponse>(actionsUrl),
    refetchInterval: false,
    placeholderData: (previousData) =>
      previousData ?? getScheduleActionsPlaceholder({ days: placeholderDays }),
    enabled: rangeReady,
  });

  const chartData = data ?? SCHEDULE_ACTIONS_PLACEHOLDER;
  const isDark = theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tickColor = '#888780';

  const periodLabel = getDashboardPeriodLabel(dateRange);

  const yMax = useMemo(() => {
    const peak = Math.max(...chartData.shutdowns, ...chartData.startups, 0);
    return Math.max(peak + (peak % 2 === 0 ? 2 : 1), 4);
  }, [chartData.shutdowns, chartData.startups]);

  const handleBarClick = useCallback(
    (_event: ChartEvent, elements: ActiveElement[]) => {
      if (!elements.length) return;
      const { datasetIndex, index } = elements[0];
      const type = datasetIndex === 0 ? 'shutdown' : 'startup';
      const date = chartData.dates[index];
      if (!date) return;
      router.push(`/activity?date=${date}&type=${type}`);
    },
    [chartData.dates, router]
  );

  const datasets = useMemo(
    () => [
      {
        label: 'Shutdowns',
        data: chartData.shutdowns,
        backgroundColor: SHUTDOWN_BAR.fill,
        borderColor: SHUTDOWN_BAR.border,
        borderWidth: 1,
        borderRadius: 4,
      },
      {
        label: 'Startups',
        data: chartData.startups,
        backgroundColor: STARTUP_BAR.fill,
        borderColor: STARTUP_BAR.border,
        borderWidth: 1,
        borderRadius: 4,
      },
    ],
    [chartData.shutdowns, chartData.startups]
  );

  const options: ChartOptions<'bar'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      onClick: handleBarClick,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (context) => ` ${context.dataset.label}: ${context.raw} actions`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: tickColor,
            font: { size: 11 },
            maxTicksLimit: chartData.days > 14 ? 8 : 7,
            maxRotation: chartData.days > 7 ? 45 : 0,
          },
        },
        y: {
          grid: { color: gridColor },
          beginAtZero: true,
          suggestedMax: yMax,
          ticks: {
            stepSize: 2,
            color: tickColor,
            font: { size: 11 },
          },
        },
      },
      datasets: {
        bar: {
          barPercentage: 0.6,
          categoryPercentage: 0.7,
        },
      },
    }),
    [chartData.days, gridColor, handleBarClick, tickColor, yMax]
  );

  if (isLoading && !data) {
    return <ScheduleActionsChartSkeleton />;
  }

  return (
    <GlassPanel className={cn('flex h-full flex-col', className)}>
      <PanelHeader
        title="Schedule actions"
        icon={BarChart2}
        accent="amber"
      />
      <DashboardChartToolbar>
        <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          {chartData.summary.total} in period
        </span>
      </DashboardChartToolbar>
      <PanelSubtitle className="min-h-10 shrink-0">
        Shutdowns vs startups · {periodLabel}
        {isFetching ? ' · updating…' : ''}
      </PanelSubtitle>

      <div className="flex flex-1 flex-col px-5 pb-5 pt-2">
        <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: SHUTDOWN_BAR.legend }}
            />
            <span>Shutdowns</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: STARTUP_BAR.legend }}
            />
            <span>Startups</span>
          </div>
        </div>

        <div className="relative w-full shrink-0" style={{ height: CHART_HEIGHT_PX }}>
          {!rangeReady ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Select a from and to date to load the chart.
            </div>
          ) : (
            <Bar data={{ labels: chartData.labels, datasets }} options={options} />
          )}
        </div>

        <DashboardChartComparisonFooter columns={3}>
          <DashboardComparisonStat
            color={TOTAL_BAR.legend}
            label="Total actions"
            value={chartData.summary.total}
            dotShape="square"
          />
          <DashboardComparisonStat
            color={SHUTDOWN_BAR.legend}
            label="Shutdowns"
            value={chartData.summary.shutdowns}
            dotShape="square"
          />
          <DashboardComparisonStat
            color={STARTUP_BAR.legend}
            label="Startups"
            value={chartData.summary.startups}
            dotShape="square"
          />
        </DashboardChartComparisonFooter>
      </div>
    </GlassPanel>
  );
}
