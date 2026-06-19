'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { Layers, Loader2 } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import DashboardDateFilter from '@/components/dashboard/dashboard-date-filter';
import {
  DashboardFilterBar,
  DashboardFilterSelect,
} from '@/components/dashboard/dashboard-filters';
import {
  appendDashboardDateQuery,
  getDashboardPeriodLabel,
  isDashboardDateRangeReady,
  type DashboardDateRange,
} from '@/lib/dashboard-date-range';
import type { PodChangeDirection, PodChangesResponse } from '@/lib/pod-changes-service';
import { cn, formatTime12h } from '@/lib/utils';

export function DashboardPodChanges({
  dateRange,
  onDateRangeChange,
}: {
  dateRange: DashboardDateRange;
  onDateRangeChange: (next: DashboardDateRange) => void;
}) {
  const [clusterFilter, setClusterFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState<PodChangeDirection>('all');
  const [calendarDate, setCalendarDate] = useState('');
  const rangeReady = isDashboardDateRangeReady(dateRange);
  const periodLabel = getDashboardPeriodLabel(dateRange);

  const queryUrl = useMemo(() => {
    const base = appendDashboardDateQuery('/api/dashboard/pod-changes', dateRange);
    const params = new URLSearchParams();
    if (clusterFilter) params.set('cluster', clusterFilter);
    if (directionFilter !== 'all') params.set('direction', directionFilter);
    if (calendarDate) params.set('date', calendarDate);
    const extra = params.toString();
    return extra ? `${base}&${extra}` : base;
  }, [dateRange, clusterFilter, directionFilter, calendarDate]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['pod-changes', dateRange, clusterFilter, directionFilter, calendarDate],
    queryFn: () => apiFetch<PodChangesResponse>(queryUrl),
    enabled: rangeReady,
    staleTime: 60_000,
    refetchInterval: 3_600_000,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });

  const availableClusters = data?.availableClusters ?? [];
  const rows = data?.rows ?? [];

  const periodHoursLabel = useMemo(() => {
    if (
      data?.captureStartDate &&
      data.calendarDate === data.captureStartDate &&
      data.captureStartHour != null
    ) {
      return `from ${formatTime12h(`${String(data.captureStartHour).padStart(2, '0')}:00`)}`;
    }
    return 'from 12:00 AM';
  }, [data?.captureStartDate, data?.captureStartHour, data?.calendarDate]);

  useEffect(() => {
    if (!data?.cluster || clusterFilter) return;
    setClusterFilter(data.cluster);
  }, [data?.cluster, clusterFilter]);

  useEffect(() => {
    if (!data?.calendarDate || calendarDate) return;
    setCalendarDate(data.calendarDate);
  }, [data?.calendarDate, calendarDate]);

  useEffect(() => {
    if (clusterFilter && availableClusters.length && !availableClusters.includes(clusterFilter)) {
      setClusterFilter('');
      setCalendarDate('');
    }
  }, [clusterFilter, availableClusters]);

  const changeCount = rows.filter((row) => row.delta != null && row.delta !== 0).length;

  return (
    <div className="space-y-5">
      <DashboardDateFilter value={dateRange} onChange={onDateRangeChange} />

      <GlassPanel className="flex flex-col">
        <PanelHeader
          title="Pod count changes"
          icon={Layers}
          accent="sky"
          action={
            <DashboardFilterBar className="justify-end">
              {availableClusters.length > 0 ? (
                <DashboardFilterSelect
                  width="lg"
                  value={clusterFilter || data?.cluster || ''}
                  onChange={(e) => {
                    setClusterFilter(e.target.value);
                    setCalendarDate('');
                  }}
                  aria-label="Filter by cluster"
                >
                  {availableClusters.map((cluster) => (
                    <option key={cluster} value={cluster}>
                      {cluster}
                    </option>
                  ))}
                </DashboardFilterSelect>
              ) : null}
              <DashboardFilterSelect
                width="sm"
                value={directionFilter}
                onChange={(e) => setDirectionFilter(e.target.value as PodChangeDirection)}
                aria-label="Filter by change direction"
              >
                <option value="all">All hours</option>
                <option value="increase">Increases only</option>
                <option value="decrease">Decreases only</option>
              </DashboardFilterSelect>
            </DashboardFilterBar>
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
            Hourly running pod counts (all namespaces) {periodHoursLabel} to 11:59 PM · {periodLabel}
            {data?.retentionDays ? ` · ${data.retentionDays}-day retention` : ''}
            {isFetching ? ' · updating…' : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-[11px]"
              disabled={!data?.previousDate}
              onClick={() => data?.previousDate && setCalendarDate(data.previousDate)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous day
            </Button>
            <span className="min-w-[6.5rem] text-center text-[11px] font-medium tabular-nums text-foreground">
              {data?.calendarDate ?? '—'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-[11px]"
              disabled={!data?.nextDate}
              onClick={() => data?.nextDate && setCalendarDate(data.nextDate)}
            >
              Next day
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {!rangeReady ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Select a from and to date to load pod changes.
          </p>
        ) : isLoading && !data ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !availableClusters.length ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Add EKS clusters under Clusters to start tracking pod count changes.
          </p>
        ) : !rows.length ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No pod count samples for this day
            {directionFilter !== 'all' ? ' matching the selected filter' : ''}.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-modern w-full min-w-[640px] text-sm">
                <thead className="bg-card/95">
                  <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 text-left font-medium">Date &amp; Time</th>
                    <th className="px-5 py-3 text-right font-medium">Previous</th>
                    <th className="px-5 py-3 text-right font-medium">Count</th>
                    <th className="px-5 py-3 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.hour}-${row.sampledAt}`} className="border-b border-border">
                      <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                        {row.dateTimeLabel}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                        {row.previousCount ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-foreground">
                        {row.podCount}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {row.delta == null || row.delta === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              'inline-flex items-center justify-end gap-0.5 font-medium tabular-nums',
                              row.delta > 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400'
                            )}
                          >
                            {row.delta > 0 ? (
                              <ArrowUp className="h-3 w-3" strokeWidth={2} />
                            ) : (
                              <ArrowDown className="h-3 w-3" strokeWidth={2} />
                            )}
                            {row.delta > 0 ? `+${row.delta}` : row.delta}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-5 py-3">
              <span className="text-xs font-medium text-muted-foreground">
                {rows.length} sample{rows.length === 1 ? '' : 's'} · {changeCount} change
                {changeCount === 1 ? '' : 's'} this day
              </span>
              <span className="text-xs text-muted-foreground">
                Day {data?.calendarDate ?? '—'} · {data?.totalDaysInRange ?? 0} days in selected period
              </span>
            </div>
          </>
        )}
      </GlassPanel>
    </div>
  );
}
