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
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
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
import { cn } from '@/lib/utils';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

const SHUTDOWN_BAR = {
  fill: 'rgba(30, 58, 138, 0.88)',
  border: '#1e3a8a',
  legend: '#1e3a8a',
  text: 'text-blue-900 dark:text-blue-300',
} as const;

const STARTUP_BAR = {
  fill: 'rgba(56, 189, 248, 0.88)',
  border: '#0284c7',
  legend: '#38bdf8',
  text: 'text-sky-600 dark:text-sky-400',
} as const;

const CHART_HEIGHT_PX = 260;

function ScheduleActionsChartSkeleton() {
  return (
    <GlassPanel className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-6 w-20 rounded-md" />
      </div>
      <Skeleton className="mx-5 mt-3 h-3 w-52" />
      <div className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex gap-4">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="w-full rounded-xl" style={{ height: CHART_HEIGHT_PX }} />
        <Skeleton className="h-10 w-full rounded-lg" />
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
    refetchInterval: 60_000,
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
        action={
          <div className="flex h-8 items-center">
            <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
              {chartData.summary.total} in period
            </span>
          </div>
        }
      />
      <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
        Shutdowns vs startups · {periodLabel}
        {isFetching ? ' · updating…' : ''}
      </p>

      <div className="flex flex-1 flex-col px-5 py-3">
        <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: SHUTDOWN_BAR.legend }}
            />
            <span>Shutdowns ({chartData.summary.shutdowns})</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: STARTUP_BAR.legend }}
            />
            <span>Startups ({chartData.summary.startups})</span>
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

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2.5">
          <div className="text-[11px]">
            <span className="text-muted-foreground">Total actions: </span>
            <span className="font-medium text-foreground">{chartData.summary.total}</span>
          </div>
          <div className="text-[11px]">
            <span className="text-muted-foreground">Shutdowns: </span>
            <span className={cn('font-medium', SHUTDOWN_BAR.text)}>{chartData.summary.shutdowns}</span>
          </div>
          <div className="text-[11px]">
            <span className="text-muted-foreground">Startups: </span>
            <span className={cn('font-medium', STARTUP_BAR.text)}>{chartData.summary.startups}</span>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}
