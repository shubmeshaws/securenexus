'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Loader2,
  Radio,
  ServerCog,
  TrendingDown,
} from '@/lib/icons';
import { Badge } from '@/components/ui/badge';
import { apiFetch, type DashboardInsights, type OverviewData } from '@/lib/api-client';
import { scheduleLiveQueryOptions } from '@/components/providers/query-provider';
import { DegradedBanner } from '@/components/pod-scheduler/degraded-banner';
import {
  PageHeader,
  GlassPanel,
  PanelHeader,
  ScrollTable,
} from '@/components/pod-scheduler/ui-primitives';
import CostSavingsTrend from '@/components/dashboard/cost-savings-trend';
import ScheduleActionsChart from '@/components/dashboard/schedule-actions-chart';
import DashboardDateFilter from '@/components/dashboard/dashboard-date-filter';
import { StoppedDurationBar } from '@/components/dashboard/stopped-duration-bar';
import {
  appendDashboardDateQuery,
  DEFAULT_DASHBOARD_DATE_RANGE,
  getDashboardPeriodLabel,
  isDashboardDateRangeReady,
  type DashboardDateRange,
} from '@/lib/dashboard-date-range';
import { formatHoursDisplay, formatRelativeTime, formatStoppedDuration, parseClusterDisplay, cn } from '@/lib/utils';

const VISIBLE_ROWS = 5;

function RowCountBadge({ shown, total }: { shown: number; total: number }) {
  if (total <= VISIBLE_ROWS) return null;
  return (
    <Badge variant="secondary" className="text-[10px] font-normal">
      {shown} of {total} · scroll for more
    </Badge>
  );
}

export default function PodSchedulerOverviewPage() {
  const [dateRange, setDateRange] = useState<DashboardDateRange>(DEFAULT_DASHBOARD_DATE_RANGE);
  const rangeReady = isDashboardDateRangeReady(dateRange);
  const periodLabel = getDashboardPeriodLabel(dateRange);

  const {
    data: overview,
    isError,
    error,
    refetch,
    dataUpdatedAt,
    isFetching: isOverviewFetching,
  } = useQuery({
    queryKey: ['overview'],
    queryFn: () => apiFetch<OverviewData>('/api/schedules/overview'),
    ...scheduleLiveQueryOptions,
    retry: 1,
  });

  const {
    data: insights,
    isLoading: isInsightsLoading,
    isFetching: isInsightsFetching,
  } = useQuery({
    queryKey: ['dashboard-insights', dateRange],
    queryFn: () =>
      apiFetch<DashboardInsights>(appendDashboardDateQuery('/api/dashboard/insights', dateRange)),
    placeholderData: (previousData) => previousData,
    enabled: rangeReady,
    staleTime: 20_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const summary = overview?.summary ?? {
    runningHours: 0,
    environmentState: 'running' as const,
  };

  const runningHours = overview?.environment?.runningHours ?? summary.runningHours ?? 0;
  const environmentState = overview?.environment?.state ?? summary.environmentState ?? 'running';
  const stateSince = overview?.environment?.stateSince;

  const uptimeTitleMeta = useMemo(() => {
    if (!overview?.environment) return null;
    const uptime = formatHoursDisplay(runningHours);
    if (environmentState === 'running') {
      return (
        <>
          Up for{' '}
          <span className="font-medium text-emerald-600 dark:text-emerald-400">{uptime}</span>
          {stateSince ? <> · running since {formatRelativeTime(stateSince)}</> : null}
        </>
      );
    }
    return (
      <>
        Environment{' '}
        <span className="font-medium text-red-500 dark:text-red-400">stopped</span>
        {stateSince ? <> since {formatRelativeTime(stateSince)}</> : null}
        {' · '}
        total uptime{' '}
        <span className="font-medium text-foreground">{uptime}</span>
      </>
    );
  }, [overview?.environment, environmentState, runningHours, stateSince]);

  const namespaceStopped = insights?.namespaceStopped ?? [];
  const standaloneStopped = insights?.standaloneStopped ?? [];
  const insightsTotals = insights?.totals;
  const periodSuffix = isInsightsFetching ? ' · updating…' : '';

  const maxEksStoppedMs = useMemo(
    () => Math.max(...namespaceStopped.map((row) => row.stoppedMs), 0),
    [namespaceStopped]
  );
  const maxStandaloneStoppedMs = useMemo(
    () => Math.max(...standaloneStopped.map((row) => row.stoppedMs), 0),
    [standaloneStopped]
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        titleMeta={uptimeTitleMeta}
        description="Live data from your clusters, schedules, and activity logs — refreshed every 30 seconds."
        action={
          overview ? (
            <span className="live-pill inline-flex items-center gap-1.5">
              <Radio className="h-3 w-3 animate-pulse" strokeWidth={1.5} />
              Live
              {dataUpdatedAt > 0 && (
                <span className="font-normal opacity-70">
                  · {isOverviewFetching ? 'updating…' : formatRelativeTime(new Date(dataUpdatedAt))}
                </span>
              )}
            </span>
          ) : undefined
        }
      />

      <DashboardDateFilter value={dateRange} onChange={setDateRange} />

      {overview?.k8sDegraded && (
        <DegradedBanner
          title="Kubernetes unreachable"
          message={overview.k8sMessage ?? 'Could not scan cluster workloads. ArgoCD data may still be available.'}
        />
      )}
      {overview?.argocdDegraded && (
        <DegradedBanner
          title="ArgoCD unreachable"
          message={overview.argocdMessage ?? 'Some sync features may be unavailable.'}
        />
      )}

      {isError && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {(error as Error)?.message ?? 'Could not refresh live cluster data.'}
          <button type="button" className="ml-2 underline" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <CostSavingsTrend dateRange={dateRange} />
        <ScheduleActionsChart dateRange={dateRange} />
      </div>

      <div
        className={cn(
          'grid items-stretch gap-5 transition-opacity lg:grid-cols-2',
          isInsightsFetching ? 'opacity-80' : 'opacity-100'
        )}
      >
            <GlassPanel className="flex h-full flex-col">
              <PanelHeader
                title="Kubernetes workload stop time"
                icon={TrendingDown}
                accent="red"
                action={<RowCountBadge shown={Math.min(namespaceStopped.length, VISIBLE_ROWS)} total={namespaceStopped.length} />}
              />
              <p className="min-h-[4.25rem] border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
                EKS only — counts actual stop→start windows from schedules, manual runs, and infrastructure actions.
                Early startup ends the window at the real start time. · {periodLabel}
                {periodSuffix}
              </p>
              {!rangeReady ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  Select a from and to date to load stop-time data.
                </p>
              ) : isInsightsLoading && !insights ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !namespaceStopped.length ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  No Kubernetes workload stop-time data yet.
                </p>
              ) : (
                <ScrollTable
                  maxRows={VISIBLE_ROWS}
                  footer={
                    insightsTotals && insightsTotals.eksStoppedMs > 0 ? (
                      <div className="flex items-center justify-between border-t border-border bg-muted/30 px-5 py-3">
                        <span className="text-xs font-medium text-muted-foreground">Total across EKS namespaces</span>
                        <span className="text-sm font-semibold text-foreground">
                          {formatStoppedDuration(insightsTotals.eksStoppedMs)}
                        </span>
                      </div>
                    ) : undefined
                  }
                >
                  <table className="w-full text-sm table-modern">
                    <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                      <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-5 py-3 text-left font-medium">Cluster</th>
                        <th className="px-5 py-3 text-left font-medium">Namespace</th>
                        <th className="w-[35%] px-5 py-3 text-left font-medium">
                          <span className="sr-only">Relative stop duration</span>
                        </th>
                        <th className="px-5 py-3 text-right font-medium">Stopped time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {namespaceStopped.map((row) => {
                        const { clusterName } = parseClusterDisplay(row.cluster);
                        return (
                          <tr key={`${row.cluster}-${row.namespace}`} className="border-b border-border">
                            <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{clusterName}</td>
                            <td className="px-5 py-3.5 font-mono text-xs text-foreground">{row.namespace}</td>
                            <td className="px-5 py-3.5 align-middle">
                              <StoppedDurationBar
                                stoppedMs={row.stoppedMs}
                                maxMs={maxEksStoppedMs}
                                accent="red"
                                barOnly
                              />
                            </td>
                            <td className="px-5 py-3.5 text-right font-medium tabular-nums text-foreground">
                              {formatStoppedDuration(row.stoppedMs)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollTable>
              )}
            </GlassPanel>

            <GlassPanel className="flex h-full flex-col">
              <PanelHeader
                title="Standalone workload stop time"
                icon={ServerCog}
                accent="amber"
                action={
                  <RowCountBadge
                    shown={Math.min(standaloneStopped.length, VISIBLE_ROWS)}
                    total={standaloneStopped.length}
                  />
                }
              />
              <p className="min-h-[4.25rem] border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
                Non-EKS EC2 instances — actual stop→start windows from scheduled or manual actions. · {periodLabel}
                {periodSuffix}
              </p>
              {!rangeReady ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  Select a from and to date to load stop-time data.
                </p>
              ) : isInsightsLoading && !insights ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !standaloneStopped.length ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  No standalone workload stop-time data yet.
                </p>
              ) : (
                <ScrollTable
                  maxRows={VISIBLE_ROWS}
                  footer={
                    insightsTotals && insightsTotals.standaloneStoppedMs > 0 ? (
                      <div className="flex items-center justify-between border-t border-border bg-muted/30 px-5 py-3">
                        <span className="text-xs font-medium text-muted-foreground">Total across instances</span>
                        <span className="text-sm font-semibold text-foreground">
                          {formatStoppedDuration(insightsTotals.standaloneStoppedMs)}
                        </span>
                      </div>
                    ) : undefined
                  }
                >
                  <table className="w-full text-sm table-modern">
                    <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                      <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-5 py-3 text-left font-medium">Instance name</th>
                        <th className="px-5 py-3 text-left font-medium">Instance type</th>
                        <th className="w-[35%] px-5 py-3 text-left font-medium">
                          <span className="sr-only">Relative stop duration</span>
                        </th>
                        <th className="px-5 py-3 text-right font-medium">Stopped time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standaloneStopped.map((row) => (
                        <tr key={row.instanceId} className="border-b border-border">
                          <td className="px-5 py-3.5 font-medium text-foreground">{row.instanceName}</td>
                          <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{row.instanceType}</td>
                          <td className="px-5 py-3.5 align-middle">
                            <StoppedDurationBar
                              stoppedMs={row.stoppedMs}
                              maxMs={maxStandaloneStoppedMs}
                              accent="amber"
                              barOnly
                            />
                          </td>
                          <td className="px-5 py-3.5 text-right font-medium tabular-nums text-foreground">
                            {formatStoppedDuration(row.stoppedMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollTable>
              )}
            </GlassPanel>
          </div>
    </div>
  );
}
