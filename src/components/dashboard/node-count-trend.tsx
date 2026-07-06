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
  NODES_SERIES_STYLE,
  PODS_SERIES_STYLE,
  formatNodeCount,
  type NodeCountTrendResponse,
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
        <div className="grid grid-cols-4 gap-4 px-4">
          <Skeleton className="mx-auto h-12 w-20" />
          <Skeleton className="mx-auto h-12 w-20" />
          <Skeleton className="mx-auto h-12 w-20" />
          <Skeleton className="mx-auto h-12 w-20" />
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

  const nodeValues = chartData.series.nodes;
  const podValues = chartData.series.pods;
  const hasNodeData = nodeValues.some((value) => value != null);
  const hasPodData = podValues.some((value) => value != null);
  const hasData = chartData.hasSamples && (hasNodeData || hasPodData);

  const periodLabel = rangeReady ? getDashboardPeriodLabel(dateRange) : 'Select period';
  const pointFill = theme === 'dark' ? '#0f172a' : '#ffffff';

  const lineDatasets = useMemo(
    () => [
      {
        label: 'Nodes',
        data: nodeValues,
        yAxisID: 'yNodes',
        borderColor: NODES_SERIES_STYLE.color,
        backgroundColor: (context: ScriptableContext<'line'>) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) return NODES_SERIES_STYLE.fillTop;
          return createAreaGradient(
            ctx,
            chartArea,
            NODES_SERIES_STYLE.fillTop,
            NODES_SERIES_STYLE.fillBottom
          );
        },
        tension: 0.35,
        borderWidth: 2.5,
        pointRadius: chartData.days <= 14 ? 3 : 2,
        pointHoverRadius: 5,
        pointBackgroundColor: pointFill,
        pointBorderColor: NODES_SERIES_STYLE.color,
        pointBorderWidth: 2,
        spanGaps: true,
        fill: true,
      },
      {
        label: 'Pods',
        data: podValues,
        yAxisID: 'yPods',
        borderColor: PODS_SERIES_STYLE.color,
        backgroundColor: 'transparent',
        tension: 0.35,
        borderWidth: 2.5,
        pointRadius: chartData.days <= 14 ? 3 : 2,
        pointHoverRadius: 5,
        pointBackgroundColor: pointFill,
        pointBorderColor: PODS_SERIES_STYLE.color,
        pointBorderWidth: 2,
        spanGaps: true,
        fill: false,
      },
    ],
    [nodeValues, podValues, pointFill, chartData.days]
  );

  const barDatasets = useMemo(
    () => [
      {
        label: 'Nodes',
        data: nodeValues,
        yAxisID: 'yNodes',
        backgroundColor: NODES_SERIES_STYLE.barBg,
        borderColor: NODES_SERIES_STYLE.color,
        borderWidth: 1,
        borderRadius: 3,
      },
      {
        label: 'Pods',
        data: podValues,
        yAxisID: 'yPods',
        backgroundColor: PODS_SERIES_STYLE.barBg,
        borderColor: PODS_SERIES_STYLE.color,
        borderWidth: 1,
        borderRadius: 3,
      },
    ],
    [nodeValues, podValues]
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
            maxRotation: chartData.days > 7 ? 45 : 0,
          },
        },
        yNodes: {
          type: 'linear' as const,
          position: 'left' as const,
          grid: { color: gridColor },
          ticks: {
            color: NODES_SERIES_STYLE.color,
            font: { size: 10 },
            callback: (value: string | number) => formatNodeCount(Number(value)),
          },
          beginAtZero: true,
        },
        yPods: {
          type: 'linear' as const,
          position: 'right' as const,
          grid: { drawOnChartArea: false },
          ticks: {
            color: PODS_SERIES_STYLE.color,
            font: { size: 10 },
            callback: (value: string | number) => formatNodeCount(Number(value)),
          },
          beginAtZero: true,
        },
      },
      datasets: {
        bar: {
          barPercentage: 0.65,
          categoryPercentage: 0.75,
        },
      },
    }),
    [chartMode, chartData.labels.length, chartData.days, gridColor, tickColor]
  );

  const formatSummary = (value: number | null) =>
    value != null ? formatNodeCount(value) : '—';

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
        Daily node & pod counts · {periodLabel} (IST, max 30 days)
        {isFetching ? ' · updating…' : ''}
      </PanelSubtitle>

      <div className="flex flex-1 flex-col px-5 pb-5 pt-2">
        <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: NODES_SERIES_STYLE.legend }}
            />
            <span>Nodes (left axis)</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: PODS_SERIES_STYLE.legend }}
            />
            <span>Pods (right axis)</span>
          </div>
        </div>

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
              No samples for the selected period yet.
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
          <DashboardChartComparisonFooter columns={4}>
            <DashboardComparisonStat
              color={NODES_SERIES_STYLE.legend}
              label="Nodes (latest)"
              value={formatSummary(chartData.summary.nodes.latest)}
            />
            <DashboardComparisonStat
              color={NODES_SERIES_STYLE.legend}
              label="Nodes (avg)"
              value={formatSummary(
                chartData.summary.nodes.average != null
                  ? Math.round(chartData.summary.nodes.average)
                  : null
              )}
            />
            <DashboardComparisonStat
              color={PODS_SERIES_STYLE.legend}
              label="Pods (latest)"
              value={formatSummary(chartData.summary.pods.latest)}
            />
            <DashboardComparisonStat
              color={PODS_SERIES_STYLE.legend}
              label="Pods (avg)"
              value={formatSummary(
                chartData.summary.pods.average != null
                  ? Math.round(chartData.summary.pods.average)
                  : null
              )}
            />
          </DashboardChartComparisonFooter>
        )}
      </div>
    </GlassPanel>
  );
}
