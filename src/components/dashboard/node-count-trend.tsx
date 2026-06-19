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
import { ArrowUp, Boxes } from 'lucide-react';
import { useTheme } from '@/components/providers/theme-provider';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  AFTER_STOP_STYLE,
  BEFORE_STOP_STYLE,
  NODE_COUNT_TREND_PLACEHOLDER,
  formatNodeCount,
  nodeCountMetricLabel,
  type NodeCountMetric,
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
} from '@/components/dashboard/dashboard-filters';
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

function DeltaBadge({ delta }: { delta: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 font-medium',
        delta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
      )}
    >
      {delta >= 0 ? (
        <ArrowUp className="h-3 w-3" strokeWidth={2} />
      ) : (
        <ArrowUp className="h-3 w-3 rotate-180" strokeWidth={2} />
      )}
      {formatNodeCount(Math.abs(delta))} nodes
    </span>
  );
}

function NodeCountTrendSkeleton() {
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

export default function NodeCountTrend({
  className,
  dateRange,
}: {
  className?: string;
  dateRange: DashboardDateRange;
}) {
  const { theme } = useTheme();
  const [chartMode, setChartMode] = useState<ChartMode>('bar');
  const [metric, setMetric] = useState<NodeCountMetric>('average');
  const [cluster, setCluster] = useState('');

  const rangeReady = isDashboardDateRangeReady(dateRange);
  const metricShort = metric === 'max' ? 'max' : 'avg';
  const clusterParam = cluster ? `&cluster=${encodeURIComponent(cluster)}` : '';
  const trendUrl = `${appendDashboardDateQuery('/api/dashboard/node-count-trend', dateRange)}&metric=${metric}${clusterParam}`;

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['node-count-trend', dateRange, metric, cluster],
    queryFn: () => apiFetch<NodeCountTrendResponse>(trendUrl),
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

  const hasData = chartData.series.some((row) => row.data.some((value) => value > 0));
  const isDark = theme === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tickColor = '#888780';

  const seriesStyles = {
    'before-stop': BEFORE_STOP_STYLE,
    'after-stop': AFTER_STOP_STYLE,
  } as const;

  const datasets = useMemo(() => {
    return chartData.series.map((row) => {
      const style = seriesStyles[row.id];
      if (chartMode === 'line') {
        return {
          label: row.label,
          data: row.data,
          borderColor: style.color,
          backgroundColor: style.fill,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          fill: true,
        };
      }
      return {
        label: row.label,
        data: row.data,
        backgroundColor: style.barBg,
        borderColor: style.color,
        borderWidth: 1,
        borderRadius: 4,
      };
    });
  }, [chartData.series, chartMode]);

  const options: ChartOptions<'line' | 'bar'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => ` ${formatNodeCount(Number(context.parsed.y))} nodes ${metricShort}`,
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
            callback: (value) => formatNodeCount(Number(value)),
          },
        },
      },
    }),
    [chartMode, chartData.days, gridColor, tickColor, metricShort]
  );

  if (isLoading && !data) {
    return <NodeCountTrendSkeleton />;
  }

  const ChartComponent = chartMode === 'line' ? Line : Bar;
  const periodLabel = getDashboardPeriodLabel(dateRange);
  const periodSummaryLabel = metric === 'max' ? 'Period max' : 'Period avg';
  const beforeSeries = chartData.series.find((row) => row.id === 'before-stop');
  const afterSeries = chartData.series.find((row) => row.id === 'after-stop');

  return (
    <GlassPanel className={cn('flex h-full flex-col', className)}>
      <PanelHeader
        title="Node count trend"
        icon={Boxes}
        accent="violet"
        action={
          <DashboardFilterBar className="justify-end">
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
              value={metric}
              onChange={setMetric}
              options={[
                { id: 'average' as const, label: 'Average' },
                { id: 'max' as const, label: 'Max' },
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
      <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
        {nodeCountMetricLabel(metric)} during daytime (after startup, before shutdown) vs stopped hours · hourly
        ready-node samples · {periodLabel}
        {chartData.isTodayLive ? ' · today live until midnight' : ''}
        {isFetching ? ' · updating…' : ''}
      </p>

      <div className="flex flex-1 flex-col px-5 py-3">
        <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5">
          {!availableClusters.length ? (
            <p className="text-[11px] text-muted-foreground">
              Add EKS clusters under Clusters to start tracking node counts.
            </p>
          ) : !hasData ? (
            <p className="text-[11px] text-muted-foreground">
              Sampling registered clusters — hourly counts appear throughout the day.
            </p>
          ) : (
            chartData.series.map((row) => {
              const style = seriesStyles[row.id];
              return (
                <div key={row.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: style.color }}
                  />
                  <span>
                    {row.label} · {formatNodeCount(row.total)} nodes {metricShort}
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
          ) : !availableClusters.length ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No registered clusters found.
            </div>
          ) : !hasData ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Waiting for the first hourly node count sample…
            </div>
          ) : (
            <ChartComponent data={{ labels: chartData.labels, datasets }} options={options} />
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2.5">
          <div className="text-[11px]">
            <span className="text-muted-foreground">Today before stop: </span>
            <span className="font-medium text-foreground">
              {formatNodeCount(chartData.summary.todayBefore)} nodes
            </span>
          </div>
          <div className="text-[11px]">
            <span className="text-muted-foreground">Today after stop: </span>
            <span className="font-medium text-foreground">
              {formatNodeCount(chartData.summary.todayAfter)} nodes
            </span>
          </div>
          <div className="text-[11px]">
            <span className="text-muted-foreground">{periodSummaryLabel} before: </span>
            <span className="font-medium text-foreground">
              {formatNodeCount(beforeSeries?.total ?? chartData.summary.periodBefore)} nodes
            </span>
          </div>
          <div className="text-[11px]">
            <span className="text-muted-foreground">{periodSummaryLabel} after: </span>
            <span className="font-medium text-foreground">
              {formatNodeCount(afterSeries?.total ?? chartData.summary.periodAfter)} nodes
            </span>
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-muted-foreground">Before vs prior: </span>
            <DeltaBadge delta={chartData.summary.priorBeforeDelta} />
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-muted-foreground">After vs prior: </span>
            <DeltaBadge delta={chartData.summary.priorAfterDelta} />
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}
