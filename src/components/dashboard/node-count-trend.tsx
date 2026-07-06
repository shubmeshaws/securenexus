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
  type ChartArea,
  type ChartOptions,
  type ScriptableContext,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import { Boxes } from 'lucide-react';
import { useTheme } from '@/components/providers/theme-provider';
import { GlassPanel, PanelHeader, PanelSubtitle } from '@/components/pod-scheduler/ui-primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  NODE_COUNT_TREND_PLACEHOLDER,
  SERIES_STYLE,
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
  DashboardChartToolbar,
} from '@/components/dashboard/dashboard-filters';
import {
  DashboardChartComparisonFooter,
  DashboardComparisonStat,
} from '@/components/dashboard/dashboard-comparison-stat';
import { cn } from '@/lib/utils';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip);

type ChartMode = 'line' | 'bar';
type SeriesMode = NodePodSeriesId;

const CHART_HEIGHT_PX = 260;

function createAreaGradient(
  ctx: CanvasRenderingContext2D,
  chartArea: ChartArea,
  topColor: string,
  bottomColor: string
) {
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(1, bottomColor);
  return gradient;
}

function NodeCountTrendSkeleton() {
  return (
    <GlassPanel className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
        <Skeleton className="h-8 w-52" />
      </div>
      <div className="flex h-10 items-center justify-end gap-3 border-b border-border/60 px-5">
        <Skeleton className="h-8 w-40 rounded-lg" />
        <Skeleton className="h-8 w-28 rounded-lg" />
      </div>
      <div className="border-b border-border px-5 pb-3 pt-0">
        <Skeleton className="h-3 w-56" />
      </div>
      <div className="flex flex-1 flex-col gap-4 px-5 py-4">
        <Skeleton className="w-full flex-1 rounded-xl" style={{ minHeight: CHART_HEIGHT_PX }} />
        <div className="grid grid-cols-2 gap-6 px-8">
          <Skeleton className="mx-auto h-12 w-24" />
          <Skeleton className="mx-auto h-12 w-24" />
        </div>
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

  const rangeReady = isDashboardDateRangeReady(dateRange);
  const queryUrl = appendDashboardDateQuery('/api/dashboard/node-count-trend', dateRange);
  const urlWithCluster = useMemo(() => {
    if (!cluster) return queryUrl;
    const sep = queryUrl.includes('?') ? '&' : '?';
    return `${queryUrl}${sep}cluster=${encodeURIComponent(cluster)}`;
  }, [queryUrl, cluster]);

  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['node-count-trend', dateRange, cluster],
    queryFn: () => apiFetch<NodeCountTrendResponse>(urlWithCluster),
    refetchInterval: 120_000,
    enabled: rangeReady,
    placeholderData: (previousData) => previousData ?? NODE_COUNT_TREND_PLACEHOLDER,
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
    if (cluster && availableClusters.length && !availableClusters.includes(cluster)) {
      setCluster('');
    }
  }, [cluster, availableClusters]);

  const seriesValues = chartData.series[seriesMode];
  const seriesSummary = chartData.summary[seriesMode];
  const hasData = chartData.hasSamples && seriesValues.some((value) => value != null);

  const seriesLabel = seriesMode === 'nodes' ? 'Ready node count' : 'Running pod count';
  const periodLabel = rangeReady ? getDashboardPeriodLabel(dateRange) : 'Select period';

  const pointFill = theme === 'dark' ? '#0f172a' : '#ffffff';

  const lineDatasets = useMemo(
    () => [
      {
        label: seriesLabel,
        data: seriesValues,
        borderColor: SERIES_STYLE.color,
        backgroundColor: (context: ScriptableContext<'line'>) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) return SERIES_STYLE.fillTop;
          return createAreaGradient(ctx, chartArea, SERIES_STYLE.fillTop, SERIES_STYLE.fillBottom);
        },
        tension: 0.35,
        borderWidth: 2.5,
        pointRadius: chartData.days <= 14 ? 3 : 2,
        pointHoverRadius: 5,
        pointBackgroundColor: pointFill,
        pointBorderColor: SERIES_STYLE.color,
        pointBorderWidth: 2,
        spanGaps: true,
        fill: true,
      },
    ],
    [seriesValues, seriesLabel, pointFill, chartData.days]
  );

  const barDatasets = useMemo(
    () => [
      {
        label: seriesLabel,
        data: seriesValues,
        backgroundColor: SERIES_STYLE.barBg,
        borderColor: SERIES_STYLE.color,
        borderWidth: 1,
        borderRadius: 3,
      },
    ],
    [seriesValues, seriesLabel]
  );

  const isDark = theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tickColor = isDark ? 'rgba(255,255,255,0.45)' : '#888780';

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' as const, intersect: false },
      layout: { padding: { top: 8, left: 0, right: 4, bottom: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          titleColor: '#f8fafc',
          bodyColor: '#e2e8f0',
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => {
              const value = context.parsed.y;
              return ` ${context.dataset.label}: ${value == null ? '—' : formatNodeCount(value)}`;
            },
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
            maxTicksLimit: chartData.labels.length > 14 ? 10 : 8,
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
          beginAtZero: true,
        },
      },
    }),
    [chartMode, chartData.labels.length, gridColor, tickColor]
  );

  const latestDisplay =
    seriesSummary.latest != null ? formatNodeCount(seriesSummary.latest) : '—';
  const averageDisplay =
    seriesSummary.average != null ? formatNodeCount(Math.round(seriesSummary.average)) : '—';

  if (isLoading && !data) {
    return <NodeCountTrendSkeleton />;
  }

  return (
    <GlassPanel className={cn('flex h-full flex-col', className)}>
      <PanelHeader title="Node & pod count trend" icon={Boxes} accent="violet" />
      <DashboardChartToolbar>
        <DashboardFilterBar className="flex-nowrap justify-end">
          {availableClusters.length > 0 ? (
            <DashboardFilterSelect
              width="lg"
              value={cluster || chartData.cluster}
              onChange={(e) => setCluster(e.target.value)}
              aria-label="Cluster filter"
              title={cluster || chartData.cluster}
            >
              {availableClusters.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </DashboardFilterSelect>
          ) : null}
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
      </DashboardChartToolbar>
      <PanelSubtitle className="min-h-10 shrink-0">
        Daily {seriesLabel.toLowerCase()} · {periodLabel} (IST, max 30 days)
        {isFetching ? ' · updating…' : ''}
      </PanelSubtitle>

      <div className="flex flex-1 flex-col px-5 pb-5 pt-2">
        <div className="mb-3 min-h-5" aria-hidden="true" />
        <div className="relative w-full shrink-0" style={{ height: CHART_HEIGHT_PX }}>
          {!rangeReady ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Select a from and to date to load trend data.
            </div>
          ) : !availableClusters.length ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Add EKS clusters under Clusters to start tracking node and pod counts.
            </div>
          ) : isError ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-red-500">
              Failed to load trend data{(error as Error)?.message ? `: ${(error as Error).message}` : ''}.
            </div>
          ) : !chartData.hasSamples ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Waiting for the first node and pod count sample…
            </div>
          ) : !hasData ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No {seriesMode} samples for the selected period yet.
            </div>
          ) : chartMode === 'line' ? (
            <Line
              data={{ labels: chartData.labels, datasets: lineDatasets }}
              options={chartOptions as ChartOptions<'line'>}
            />
          ) : (
            <Bar
              data={{ labels: chartData.labels, datasets: barDatasets }}
              options={chartOptions as ChartOptions<'bar'>}
            />
          )}
        </div>

        {hasData && (
          <DashboardChartComparisonFooter columns={2}>
            <DashboardComparisonStat
              color={SERIES_STYLE.color}
              label="Latest"
              value={latestDisplay}
            />
            <DashboardComparisonStat
              color={SERIES_STYLE.color}
              label="Period avg"
              value={averageDisplay}
            />
          </DashboardChartComparisonFooter>
        )}
      </div>
    </GlassPanel>
  );
}
