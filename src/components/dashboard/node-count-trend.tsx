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
  TODAY_SERIES_STYLE,
  YESTERDAY_SERIES_STYLE,
  formatNodeCount,
  type NodeCountTrendResponse,
  type NodePodSeriesId,
} from '@/lib/node-count-trend-data';
import {
  DashboardFilterBar,
  DashboardFilterSelect,
  DashboardToggleGroup,
} from '@/components/dashboard/dashboard-filters';
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
        <Skeleton className="h-7 w-28 rounded-lg" />
      </div>
      <Skeleton className="mx-5 mt-3 h-3 w-56" />
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

function ComparisonStat({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <span>{label}</span>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
    </div>
  );
}

export default function NodeCountTrend({
  className,
}: {
  className?: string;
  dateRange?: unknown;
}) {
  const { theme } = useTheme();
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [seriesMode, setSeriesMode] = useState<SeriesMode>('nodes');
  const [cluster, setCluster] = useState('');

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (cluster) params.set('cluster', cluster);
    const qs = params.toString();
    return qs ? `/api/dashboard/node-count-trend?${qs}` : '/api/dashboard/node-count-trend';
  }, [cluster]);

  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['node-count-trend', cluster],
    queryFn: () => apiFetch<NodeCountTrendResponse>(queryUrl),
    refetchInterval: 120_000,
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

  const comparison = chartData.comparison[seriesMode];
  const hasData =
    chartData.hasSamples &&
    (comparison.today.data.some((value) => value != null) ||
      comparison.yesterday.data.some((value) => value != null));

  const seriesLabel = seriesMode === 'nodes' ? 'Ready node count' : 'Running pod count';

  const pointFill = theme === 'dark' ? '#0f172a' : '#ffffff';

  const lineDatasets = useMemo(
    () => [
      {
        label: 'Yesterday',
        data: comparison.yesterday.data,
        borderColor: YESTERDAY_SERIES_STYLE.color,
        backgroundColor: (context: ScriptableContext<'line'>) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) return YESTERDAY_SERIES_STYLE.fillTop;
          return createAreaGradient(
            ctx,
            chartArea,
            YESTERDAY_SERIES_STYLE.fillTop,
            YESTERDAY_SERIES_STYLE.fillBottom
          );
        },
        tension: 0.42,
        borderWidth: 2.5,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: pointFill,
        pointBorderColor: YESTERDAY_SERIES_STYLE.color,
        pointBorderWidth: 2,
        spanGaps: true,
        fill: true,
      },
      {
        label: 'Today',
        data: comparison.today.data,
        borderColor: TODAY_SERIES_STYLE.color,
        backgroundColor: (context: ScriptableContext<'line'>) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) return TODAY_SERIES_STYLE.fillTop;
          return createAreaGradient(
            ctx,
            chartArea,
            TODAY_SERIES_STYLE.fillTop,
            TODAY_SERIES_STYLE.fillBottom
          );
        },
        tension: 0.42,
        borderWidth: 2.5,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: pointFill,
        pointBorderColor: TODAY_SERIES_STYLE.color,
        pointBorderWidth: 2,
        spanGaps: true,
        fill: true,
      },
    ],
    [comparison.today.data, comparison.yesterday.data, pointFill]
  );

  const barDatasets = useMemo(
    () => [
      {
        label: 'Yesterday',
        data: comparison.yesterday.data,
        backgroundColor: YESTERDAY_SERIES_STYLE.barBg,
        borderColor: YESTERDAY_SERIES_STYLE.color,
        borderWidth: 1,
        borderRadius: 3,
      },
      {
        label: 'Today',
        data: comparison.today.data,
        backgroundColor: TODAY_SERIES_STYLE.barBg,
        borderColor: TODAY_SERIES_STYLE.color,
        borderWidth: 1,
        borderRadius: 3,
      },
    ],
    [comparison.today.data, comparison.yesterday.data]
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
          beginAtZero: true,
        },
      },
    }),
    [chartMode, chartData.labels.length, gridColor, tickColor]
  );

  const yesterdayDisplay =
    comparison.yesterday.latest != null ? formatNodeCount(comparison.yesterday.latest) : '—';
  const todayDisplay =
    comparison.today.latest != null ? formatNodeCount(comparison.today.latest) : '—';

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
      <PanelSubtitle>
        Hourly {seriesLabel.toLowerCase()} · Today vs yesterday (IST)
        {isFetching ? ' · updating…' : ''}
      </PanelSubtitle>

      <div className="flex flex-1 flex-col px-5 pb-5 pt-2">
        <div className="relative w-full shrink-0" style={{ height: CHART_HEIGHT_PX }}>
          {!availableClusters.length ? (
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
              No {seriesMode} samples for today or yesterday yet.
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
          <div className="mt-4 grid grid-cols-2 gap-6 border-t border-border/50 pt-5">
            <ComparisonStat
              color={YESTERDAY_SERIES_STYLE.color}
              label="Yesterday"
              value={yesterdayDisplay}
            />
            <ComparisonStat
              color={TODAY_SERIES_STYLE.color}
              label="Today"
              value={todayDisplay}
            />
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
