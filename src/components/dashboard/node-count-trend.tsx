'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  colorWithAlpha,
  dayTrendLineStyle,
  dayTrendShouldFill,
  formatNodeCount,
  resolveDayTrendHighlight,
  type DayTrendHighlight,
  type DayTrendSeries,
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
import { cn } from '@/lib/utils';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip);

type ChartMode = 'line' | 'bar';
type SeriesMode = NodePodSeriesId;

const CHART_HEIGHT_PX = 260;
const COMPACT_LEGEND_DAY_THRESHOLD = 7;

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
        <Skeleton className="h-5 w-40" />
        <Skeleton className="w-full flex-1 rounded-xl" style={{ minHeight: CHART_HEIGHT_PX }} />
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      </div>
    </GlassPanel>
  );
}

function buildLineDataset(
  day: DayTrendSeries,
  index: number,
  total: number,
  pointFill: string,
  highlight: DayTrendHighlight
) {
  const style = dayTrendLineStyle(index, total);
  const muted = highlight === 'muted';
  const emphasized = highlight === 'emphasized';
  const fill =
    !muted && (emphasized || (highlight === 'default' && dayTrendShouldFill(index, total)));

  return {
    label: day.label,
    data: day.data,
    borderColor: muted ? colorWithAlpha(style.color, 0.14) : style.color,
    backgroundColor: (context: ScriptableContext<'line'>) => {
      if (!fill) return 'transparent';
      const chart = context.chart;
      const { ctx, chartArea } = chart;
      if (!chartArea) return style.fillTop;
      return createAreaGradient(ctx, chartArea, style.fillTop, style.fillBottom);
    },
    tension: 0.42,
    borderWidth: muted ? 1 : emphasized || index >= total - 2 ? 2.5 : 2,
    pointRadius: muted ? 0 : emphasized || index >= total - 2 ? 3 : total > 14 ? 0 : 2,
    pointHoverRadius: muted ? 0 : 5,
    pointBackgroundColor: pointFill,
    pointBorderColor: muted ? colorWithAlpha(style.color, 0.14) : style.color,
    pointBorderWidth: 2,
    spanGaps: true,
    fill,
    order: muted ? 0 : 1,
  };
}

function buildBarDataset(
  day: DayTrendSeries,
  index: number,
  total: number,
  highlight: DayTrendHighlight
) {
  const style = dayTrendLineStyle(index, total);
  const muted = highlight === 'muted';
  return {
    label: day.label,
    data: day.data,
    backgroundColor: muted ? colorWithAlpha(style.color, 0.12) : style.barBg,
    borderColor: muted ? colorWithAlpha(style.color, 0.14) : style.color,
    borderWidth: 1,
    borderRadius: 2,
    order: muted ? 0 : 1,
  };
}

function DayTrendLegend({
  daySeries,
  dayCount,
  selectedDates,
  onToggleDay,
  onClearSelection,
}: {
  daySeries: DayTrendSeries[];
  dayCount: number;
  selectedDates: Set<string>;
  onToggleDay: (date: string) => void;
  onClearSelection: () => void;
}) {
  const selectionEnabled = dayCount >= 1;
  const hasSelection = selectedDates.size > 0;
  const compact = dayCount > COMPACT_LEGEND_DAY_THRESHOLD;

  return (
    <div className="mt-3 shrink-0 border-t border-border/50 pt-3">
      {selectionEnabled ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[10px] leading-snug text-muted-foreground">
            Click a day to highlight its line. Click again to deselect.
          </p>
          {hasSelection ? (
            <button
              type="button"
              onClick={onClearSelection}
              className="shrink-0 text-[10px] font-medium text-blue-500 hover:text-blue-400"
            >
              Show all
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          'grid gap-1.5',
          compact ? 'max-h-[7.75rem] grid-cols-7 overflow-y-auto pr-0.5' : 'grid-cols-7'
        )}
      >
        {daySeries.map((day, index) => {
          const style = dayTrendLineStyle(index, dayCount);
          const value = day.latest != null ? formatNodeCount(day.latest) : '—';
          const isSelected = selectedDates.has(day.date);
          const isMuted = hasSelection && !isSelected;

          return (
            <button
              key={day.date}
              type="button"
              disabled={!selectionEnabled}
              onClick={() => onToggleDay(day.date)}
              title={selectionEnabled ? `Toggle ${day.label}` : day.label}
              className={cn(
                'flex min-w-0 flex-col items-center rounded-md border px-1 py-1.5 text-center transition-all',
                compact ? 'gap-0.5' : 'gap-1',
                selectionEnabled && 'cursor-pointer hover:bg-muted/40',
                !selectionEnabled && 'cursor-default border-transparent',
                selectionEnabled && isSelected && 'border-border bg-muted/50 shadow-sm',
                selectionEnabled && !isSelected && 'border-transparent',
                isMuted && 'opacity-35'
              )}
            >
              <div className="flex w-full min-w-0 items-center justify-center gap-1">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: style.color }}
                />
                <span className="truncate text-[10px] leading-none text-muted-foreground">
                  {day.label}
                </span>
              </div>
              <span
                className={cn(
                  'font-semibold tabular-nums leading-none text-foreground',
                  compact ? 'text-sm' : 'text-lg'
                )}
              >
                {value}
              </span>
            </button>
          );
        })}
      </div>
    </div>
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
  const [selectedDates, setSelectedDates] = useState<Set<string>>(() => new Set());

  const rangeReady = isDashboardDateRangeReady(dateRange);
  const periodLabel = rangeReady ? getDashboardPeriodLabel(dateRange) : 'Select period';
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

  useEffect(() => {
    setSelectedDates(new Set());
  }, [dateRange, seriesMode, cluster]);

  const toggleDay = useCallback((date: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedDates(new Set());
  }, []);

  const daySeries = chartData.hourlyByDay[seriesMode];
  const hasData =
    chartData.hasSamples && daySeries.some((day) => day.data.some((value) => value != null));

  const seriesLabel = seriesMode === 'nodes' ? 'Ready node count' : 'Running pod count';
  const pointFill = theme === 'dark' ? '#0f172a' : '#ffffff';
  const dayCount = daySeries.length;
  const selectionEnabled = dayCount >= 1;

  const lineDatasets = useMemo(
    () =>
      daySeries.map((day, index) =>
        buildLineDataset(
          day,
          index,
          dayCount,
          pointFill,
          resolveDayTrendHighlight(day.date, selectedDates, selectionEnabled)
        )
      ),
    [daySeries, dayCount, pointFill, selectedDates, selectionEnabled]
  );

  const barDatasets = useMemo(
    () =>
      daySeries.map((day, index) =>
        buildBarDataset(
          day,
          index,
          dayCount,
          resolveDayTrendHighlight(day.date, selectedDates, selectionEnabled)
        )
      ),
    [daySeries, dayCount, selectedDates, selectionEnabled]
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
          filter: (item: { datasetIndex: number }) => {
            if (!selectionEnabled || selectedDates.size === 0) return true;
            const day = daySeries[item.datasetIndex];
            return day ? selectedDates.has(day.date) : true;
          },
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
      datasets: {
        bar: {
          barPercentage: dayCount > 7 ? 0.85 : 0.65,
          categoryPercentage: dayCount > 7 ? 0.9 : 0.75,
        },
      },
    }),
    [
      chartMode,
      chartData.labels.length,
      gridColor,
      tickColor,
      dayCount,
      daySeries,
      selectedDates,
      selectionEnabled,
    ]
  );

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
        Hourly {seriesLabel.toLowerCase()} · {periodLabel} (IST)
        {isFetching ? ' · updating…' : ''}
      </PanelSubtitle>

      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-2">
        <div className="mb-3 min-h-5 shrink-0" aria-hidden="true" />
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

        {hasData ? (
          <DayTrendLegend
            daySeries={daySeries}
            dayCount={dayCount}
            selectedDates={selectedDates}
            onToggleDay={toggleDay}
            onClearSelection={clearSelection}
          />
        ) : null}
      </div>
    </GlassPanel>
  );
}
