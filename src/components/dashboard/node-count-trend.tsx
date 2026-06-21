'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { Boxes, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTheme } from '@/components/providers/theme-provider';
import { GlassPanel, PanelHeader, PanelSubtitle } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  NODE_COUNT_TREND_PLACEHOLDER,
  NODES_SERIES_STYLE,
  PODS_SERIES_STYLE,
  formatNodeCount,
  type NodeCountTrendResponse,
  type NodePodSeriesId,
} from '@/lib/node-count-trend-data';
import {
  appendDashboardDateQuery,
  getDashboardPeriodLabel,
  isDashboardDateRangeReady,
  type DashboardDateRange,
} from '@/lib/dashboard-date-range';
import {
  DashboardFilterBar,
  DashboardFilterSelect,
  DashboardToggleGroup,
} from '@/components/dashboard/dashboard-filters';
import { cn, formatTime12h } from '@/lib/utils';

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
type SeriesMode = NodePodSeriesId;

const CHART_HEIGHT_PX = 260;

const SERIES_STYLES: Record<NodePodSeriesId, { color: string; fill: string; barBg: string }> = {
  nodes: NODES_SERIES_STYLE,
  pods: PODS_SERIES_STYLE,
};

function NodeCountTrendSkeleton() {
  return (
    <GlassPanel className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-7 w-40 rounded-lg" />
      </div>
      <Skeleton className="mx-5 mt-3 h-3 w-72" />
      <div className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex gap-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="w-full flex-1 rounded-xl" style={{ minHeight: CHART_HEIGHT_PX }} />
      </div>
    </GlassPanel>
  );
}

export default function NodeCountTrend({
  className,
  dateRange,
}: {
  className?: string;
  dateRange: DashboardDateRange;
}) {
  const { theme } = useTheme();
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [seriesMode, setSeriesMode] = useState<SeriesMode>('nodes');
  const [cluster, setCluster] = useState('');
  const [calendarDate, setCalendarDate] = useState('');

  const rangeReady = isDashboardDateRangeReady(dateRange);
  const periodLabel = getDashboardPeriodLabel(dateRange);

  const queryUrl = useMemo(() => {
    const base = appendDashboardDateQuery('/api/dashboard/node-count-trend', dateRange);
    const params = new URLSearchParams();
    if (cluster) params.set('cluster', cluster);
    if (calendarDate) params.set('date', calendarDate);
    const extra = params.toString();
    return extra ? `${base}&${extra}` : base;
  }, [dateRange, cluster, calendarDate]);

  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['node-count-trend', dateRange, cluster, calendarDate],
    queryFn: () => apiFetch<NodeCountTrendResponse>(queryUrl),
    refetchInterval: 60_000,
    placeholderData: (previousData) => previousData ?? NODE_COUNT_TREND_PLACEHOLDER,
    enabled: rangeReady,
  });

  const chartData = data ?? NODE_COUNT_TREND_PLACEHOLDER;
  const availableClusters = chartData.availableClusters.length
    ? chartData.availableClusters
    : cluster
      ? [cluster]
      : [];

  useEffect(() => {
    if (!cluster && chartData.cluster) {
      setCluster(chartData.cluster);
    }
  }, [cluster, chartData.cluster]);

  useEffect(() => {
    if (!chartData.calendarDate || calendarDate) return;
    setCalendarDate(chartData.calendarDate);
  }, [chartData.calendarDate, calendarDate]);

  useEffect(() => {
    if (cluster && availableClusters.length && !availableClusters.includes(cluster)) {
      setCluster('');
      setCalendarDate('');
    }
  }, [cluster, availableClusters]);

  const visibleSeries = useMemo(
    () => chartData.series.filter((row) => row.id === seriesMode),
    [chartData.series, seriesMode]
  );

  const hasData =
    chartData.hasSamples && visibleSeries.some((row) => row.data.some((value) => value != null));
  const seriesLabel = seriesMode === 'nodes' ? 'Ready node count' : 'Running pod count';

  const periodHoursLabel = useMemo(() => {
    if (
      chartData.captureStartDate &&
      chartData.calendarDate === chartData.captureStartDate &&
      chartData.captureStartHour != null
    ) {
      return `from ${formatTime12h(`${String(chartData.captureStartHour).padStart(2, '0')}:00`)}`;
    }
    return 'from 12:00 AM';
  }, [chartData.captureStartDate, chartData.captureStartHour, chartData.calendarDate]);

  const isDark = theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tickColor = '#888780';

  const datasets = useMemo(() => {
    return visibleSeries.map((row) => {
      const style = SERIES_STYLES[row.id];
      if (chartMode === 'line') {
        return {
          label: row.label,
          data: row.data,
          borderColor: style.color,
          backgroundColor: style.fill,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: chartData.labels.length > 24 ? 0 : 2,
          pointHoverRadius: 4,
          spanGaps: true,
          fill: false,
        };
      }
      return {
        label: row.label,
        data: row.data,
        backgroundColor: style.barBg,
        borderColor: style.color,
        borderWidth: 1,
        borderRadius: 3,
      };
    });
  }, [visibleSeries, chartData.labels.length, chartMode]);

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' as const, intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) =>
              ` ${context.dataset.label}: ${formatNodeCount(Number(context.parsed.y))}`,
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: chartMode === 'line',
            color: gridColor,
          },
          ticks: {
            color: tickColor,
            font: { size: 10 },
            maxTicksLimit: chartData.labels.length > 24 ? 12 : 8,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: gridColor },
          ticks: {
            color: tickColor,
            font: { size: 10 },
            callback: (value: string | number) => formatNodeCount(Number(value)),
          },
        },
      },
    }),
    [chartMode, chartData.labels.length, gridColor, tickColor]
  );

  if (isLoading && !data) {
    return <NodeCountTrendSkeleton />;
  }

  return (
    <GlassPanel className={cn('flex h-full flex-col', className)}>
      <PanelHeader
        title="Node & pod count trend"
        icon={Boxes}
        accent="violet"
        titleAddon={
          availableClusters.length > 0 ? (
            <DashboardFilterSelect
              width="lg"
              value={cluster || chartData.cluster}
              onChange={(e) => {
                setCluster(e.target.value);
                setCalendarDate('');
              }}
              aria-label="Cluster filter"
              title={cluster || chartData.cluster}
            >
              {availableClusters.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </DashboardFilterSelect>
          ) : null
        }
        action={
          <DashboardFilterBar className="justify-end">
            <DashboardToggleGroup
              value={seriesMode}
              onChange={setSeriesMode}
              capitalize
              options={[
                { id: 'nodes' as const, label: 'nodes' },
                { id: 'pods' as const, label: 'pods' },
              ]}
            />
            <DashboardToggleGroup
              value={chartMode}
              onChange={setChartMode}
              capitalize
              options={[
                { id: 'line' as const, label: 'line' },
                { id: 'bar' as const, label: 'bar' },
              ]}
            />
          </DashboardFilterBar>
        }
      />
      <PanelSubtitle
        action={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-[11px]"
              disabled={!chartData.previousDate}
              onClick={() => chartData.previousDate && setCalendarDate(chartData.previousDate)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous day
            </Button>
            <span className="min-w-[6.5rem] text-center text-[11px] font-medium tabular-nums text-foreground">
              {chartData.calendarDate || '—'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-[11px]"
              disabled={!chartData.nextDate}
              onClick={() => chartData.nextDate && setCalendarDate(chartData.nextDate)}
            >
              Next day
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        }
      >
        Hourly {seriesLabel.toLowerCase()} {periodHoursLabel} to 11:59 PM · {periodLabel}
        {chartData.retentionDays ? ` · ${chartData.retentionDays}-day retention` : ''}
        {isFetching ? ' · updating…' : ''}
      </PanelSubtitle>

      <div className="flex flex-1 flex-col px-5 py-3">
        <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5">
          {!rangeReady ? (
            <p className="text-[11px] text-muted-foreground">
              Select a from and to date to load the chart.
            </p>
          ) : !availableClusters.length ? (
            <p className="text-[11px] text-muted-foreground">
              Add EKS clusters under Clusters to start tracking node and pod counts.
            </p>
          ) : !chartData.hasSamples ? (
            <p className="text-[11px] text-muted-foreground">
              Sampling registered clusters — hourly counts appear once samples are collected.
            </p>
          ) : !hasData ? (
            <p className="text-[11px] text-muted-foreground">
              No {seriesMode} samples for {chartData.calendarDate || 'this day'}.
            </p>
          ) : (
            visibleSeries.map((row) => {
              const style = SERIES_STYLES[row.id];
              const latest =
                [...row.data].reverse().find((value) => value != null) ??
                row.data.at(-1) ??
                0;
              return (
                <div key={row.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: style.color }}
                  />
                  <span>
                    {row.label} · latest {formatNodeCount(latest)}
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
          ) : isError ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-red-500">
              Failed to load trend data{(error as Error)?.message ? `: ${(error as Error).message}` : ''}.
              Refresh the page after the server restarts.
            </div>
          ) : !availableClusters.length ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No registered clusters found.
            </div>
          ) : !chartData.hasSamples ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Waiting for the first node and pod count sample…
            </div>
          ) : !hasData ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No {seriesMode} samples for {chartData.calendarDate || 'this day'}.
            </div>
          ) : chartMode === 'line' ? (
            <Line data={{ labels: chartData.labels, datasets }} options={chartOptions as ChartOptions<'line'>} />
          ) : (
            <Bar data={{ labels: chartData.labels, datasets }} options={chartOptions as ChartOptions<'bar'>} />
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
