'use client';

import { useQuery } from '@tanstack/react-query';
import {
  CalendarRange,
  Icons,
  Loader2,
  PiggyBank,
  Radio,
  ServerCog,
  TrendingDown,
} from '@/lib/icons';
import { ModernIcon } from '@/components/ui/modern-icon';
import { Badge } from '@/components/ui/badge';
import { apiFetch, type OverviewData } from '@/lib/api-client';
import { scheduleLiveQueryOptions } from '@/components/providers/query-provider';
import { DegradedBanner } from '@/components/pod-scheduler/degraded-banner';
import {
  PageHeader,
  StatCard,
  GlassPanel,
  PanelHeader,
  ScrollTable,
} from '@/components/pod-scheduler/ui-primitives';
import {
  ScheduleClusterCell,
  ScheduleTargetCell,
  ScheduleNextRunCell,
  ScheduleShutdownAtCell,
  ScheduleStartupAtCell,
  ScheduleStatusCell,
} from '@/components/pod-scheduler/schedule-table-cells';
import { formatHoursDisplay, formatRelativeTime, formatUsd, parseClusterDisplay } from '@/lib/utils';

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
  const { data, isLoading, isError, error, refetch, dataUpdatedAt, isFetching } = useQuery({
    queryKey: ['overview'],
    queryFn: () => apiFetch<OverviewData>('/api/schedules/overview'),
    ...scheduleLiveQueryOptions,
    retry: 1,
  });

  const summary = data?.summary ?? {
    totalApps: 0,
    running: 0,
    stopped: 0,
    scheduled: 0,
    connectedClusters: 0,
    runningHours: 0,
    stoppedHours: 0,
    environmentState: 'running' as const,
  };

  const runningHours = data?.environment?.runningHours ?? summary.runningHours ?? 0;
  const stoppedHours = data?.environment?.stoppedHours ?? summary.stoppedHours ?? 0;
  const environmentState = data?.environment?.state ?? summary.environmentState ?? 'running';
  const activeSchedules = data?.activeSchedules ?? [];
  const insights = data?.insights;
  const namespaceStopped = insights?.namespaceStopped ?? [];
  const instanceTypes = insights?.instanceTypes ?? [];
  const costSavings = insights?.costSavings ?? [];
  const savingsTotals = insights?.totals;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        description="Live data from your clusters, schedules, and activity logs — refreshed every 30 seconds."
        action={
          data ? (
            <span className="live-pill inline-flex items-center gap-1.5">
              <Radio className="h-3 w-3 animate-pulse" strokeWidth={1.5} />
              Live
              {dataUpdatedAt > 0 && (
                <span className="font-normal opacity-70">
                  · {isFetching ? 'updating…' : formatRelativeTime(new Date(dataUpdatedAt))}
                </span>
              )}
            </span>
          ) : undefined
        }
      />

      {data?.k8sDegraded && (
        <DegradedBanner
          title="Kubernetes unreachable"
          message={data.k8sMessage ?? 'Could not scan cluster workloads. ArgoCD data may still be available.'}
        />
      )}
      {data?.argocdDegraded && (
        <DegradedBanner
          title="ArgoCD unreachable"
          message={data.argocdMessage ?? 'Some sync features may be unavailable.'}
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

      {isLoading && !data ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
        </div>
      ) : (
        <>
          <div className="grid w-full grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
            <StatCard label="Total Apps" value={summary.totalApps} icon={Icons.dashboard.apps} accent="blue" />
            <StatCard label="Running" value={summary.running} icon={Icons.dashboard.running} accent="emerald" />
            <StatCard label="Stopped" value={summary.stopped} icon={Icons.dashboard.stopped} accent="red" />
            <StatCard label="Clusters" value={summary.connectedClusters ?? 0} icon={Icons.dashboard.clusters} accent="amber" />
            <StatCard label="Scheduled" value={summary.scheduled} icon={Icons.dashboard.scheduled} accent="sky" />
            <StatCard
              label="Running Hours"
              value={formatHoursDisplay(runningHours)}
              icon={Icons.dashboard.runningHours}
              accent="emerald"
              trend={environmentState === 'running' ? 'Live' : undefined}
            />
            <StatCard
              label="Stopped Hours"
              value={formatHoursDisplay(stoppedHours)}
              icon={Icons.dashboard.stoppedHours}
              accent="red"
              trend={environmentState === 'stopped' ? 'Live' : undefined}
            />
          </div>

          <GlassPanel className="px-5 py-4">
            <div className="flex items-start gap-3">
              <ModernIcon icon={Radio} accent="emerald" size="sm" />
              <p className="text-xs leading-relaxed text-muted-foreground">
              Environment is currently{' '}
              <span className={environmentState === 'running' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}>
                {environmentState}
              </span>
              {data?.environment?.stateSince && (
                <> · since {formatRelativeTime(data.environment.stateSince)}</>
              )}
              . All metrics below are computed from live cluster APIs, the database, and activity logs.
              </p>
            </div>
          </GlassPanel>

          <div className="grid gap-5 lg:grid-cols-2">
            <GlassPanel>
              <PanelHeader
                title="Namespace Stopped Time"
                icon={TrendingDown}
                accent="red"
                action={<RowCountBadge shown={Math.min(namespaceStopped.length, VISIBLE_ROWS)} total={namespaceStopped.length} />}
              />
              {!namespaceStopped.length ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  No stopped-time data yet. Hours accrue from successful schedule shutdown/startup pairs.
                </p>
              ) : (
                <ScrollTable
                  maxRows={VISIBLE_ROWS}
                  footer={
                    savingsTotals && savingsTotals.stoppedHours > 0 ? (
                      <div className="flex items-center justify-between border-t border-border bg-muted/30 px-5 py-3">
                        <span className="text-xs font-medium text-muted-foreground">Total across namespaces</span>
                        <span className="text-sm font-semibold text-foreground">
                          {formatHoursDisplay(savingsTotals.stoppedHours)}
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
                        <th className="px-5 py-3 text-right font-medium">Stopped</th>
                      </tr>
                    </thead>
                    <tbody>
                      {namespaceStopped.map((row) => {
                        const { clusterName } = parseClusterDisplay(row.cluster);
                        return (
                          <tr key={`${row.cluster}-${row.namespace}`} className="border-b border-border">
                            <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{clusterName}</td>
                            <td className="px-5 py-3.5 font-mono text-xs text-foreground">{row.namespace}</td>
                            <td className="px-5 py-3.5 text-right font-medium text-foreground">
                              {formatHoursDisplay(row.stoppedHours)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollTable>
              )}
            </GlassPanel>

            <GlassPanel>
              <PanelHeader
                title="Instance Types"
                icon={ServerCog}
                accent="amber"
                action={<RowCountBadge shown={Math.min(instanceTypes.length, VISIBLE_ROWS)} total={instanceTypes.length} />}
              />
              {!instanceTypes.length ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  Connect a cluster to see node instance types.
                </p>
              ) : (
                <ScrollTable maxRows={VISIBLE_ROWS}>
                  <table className="w-full text-sm table-modern">
                    <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                      <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-5 py-3 text-left font-medium">Cluster</th>
                        <th className="px-5 py-3 text-left font-medium">Instance type</th>
                        <th className="px-5 py-3 text-left font-medium">Capacity</th>
                        <th className="px-5 py-3 text-right font-medium">Nodes</th>
                        <th className="px-5 py-3 text-right font-medium">$/hr</th>
                      </tr>
                    </thead>
                    <tbody>
                      {instanceTypes.map((row) => {
                        const { clusterName } = parseClusterDisplay(row.cluster);
                        return (
                          <tr
                            key={`${row.cluster}-${row.instanceType}-${row.capacityType}`}
                            className="border-b border-border"
                          >
                            <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{clusterName}</td>
                            <td className="px-5 py-3.5 font-mono text-xs text-foreground">{row.instanceType}</td>
                            <td className="px-5 py-3.5">
                              <span
                                className={
                                  row.capacityType === 'spot'
                                    ? 'rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400'
                                    : 'rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400'
                                }
                              >
                                {row.capacityType === 'spot' ? 'Spot' : 'On-Demand'}
                              </span>
                            </td>
                            <td className="px-5 py-3.5 text-right font-medium text-foreground">{row.count}</td>
                            <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">
                              {formatUsd(row.hourlyPrice)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollTable>
              )}
            </GlassPanel>
          </div>

          <GlassPanel>
            <PanelHeader
              title="Cost Savings"
              icon={PiggyBank}
              accent="emerald"
              action={
                <RowCountBadge shown={Math.min(costSavings.length, VISIBLE_ROWS)} total={costSavings.length} />
              }
            />
            <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
              Day totals reset at midnight · month totals accumulate from the 1st (
              {insights?.costCalendarTz ?? 'UTC'}). Rates derived from instance types (spot vs on-demand).
              Override spot discount via <code className="text-[10px]">COST_SPOT_MULTIPLIER</code> and timezone via{' '}
              <code className="text-[10px]">COST_CALENDAR_TZ</code>.
            </p>
            {!costSavings.length ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No savings data yet. Requires stopped-time history and reachable cluster APIs.
              </p>
            ) : (
              <ScrollTable maxRows={VISIBLE_ROWS}>
                <table className="w-full text-sm table-modern">
                  <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                    <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-5 py-3 text-left font-medium">Namespace</th>
                      <th className="px-5 py-3 text-right font-medium">CPU / day</th>
                      <th className="px-5 py-3 text-right font-medium">CPU / month</th>
                      <th className="px-5 py-3 text-right font-medium">Memory / day</th>
                      <th className="px-5 py-3 text-right font-medium">Memory / month</th>
                      <th className="px-5 py-3 text-right font-medium">Total saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costSavings.map((row) => (
                      <tr key={`${row.cluster}-${row.namespace}`} className="border-b border-border">
                        <td className="px-5 py-3.5">
                          <p className="font-mono text-xs text-foreground">{row.namespace}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {parseClusterDisplay(row.cluster).clusterName}
                            {row.cpuCores > 0 || row.memoryGb > 0
                              ? ` · ${row.cpuCores} vCPU · ${row.memoryGb} GiB`
                              : ''}
                            {row.stoppedHoursToday > 0
                              ? ` · ${formatHoursDisplay(row.stoppedHoursToday)} stopped today`
                              : ''}
                          </p>
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                          {formatUsd(row.cpuSavedPerDay)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                          {formatUsd(row.cpuSavedPerMonth)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-sky-600 dark:text-sky-400">
                          {formatUsd(row.memorySavedPerDay)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-sky-600 dark:text-sky-400">
                          {formatUsd(row.memorySavedPerMonth)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-medium text-foreground">
                          {formatUsd(row.cpuSavedTotal + row.memorySavedTotal)}
                        </td>
                      </tr>
                    ))}
                    {savingsTotals && (
                      <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                        <td className="px-5 py-3.5 text-xs uppercase tracking-wider text-muted-foreground">
                          Total
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                          {formatUsd(savingsTotals.cpuSavedPerDay)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                          {formatUsd(savingsTotals.cpuSavedPerMonth)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-sky-600 dark:text-sky-400">
                          {formatUsd(savingsTotals.memorySavedPerDay)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-xs text-sky-600 dark:text-sky-400">
                          {formatUsd(savingsTotals.memorySavedPerMonth)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-medium text-foreground">
                          {formatUsd(savingsTotals.cpuSavedTotal + savingsTotals.memorySavedTotal)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </GlassPanel>

          <GlassPanel>
            <PanelHeader
              title="Schedules"
              icon={CalendarRange}
              accent="violet"
              action={
                <div className="flex items-center gap-2">
                  <span className="hidden text-[10px] text-muted-foreground sm:inline">
                    Live / running first
                  </span>
                  <RowCountBadge shown={Math.min(activeSchedules.length, VISIBLE_ROWS)} total={activeSchedules.length} />
                </div>
              }
            />
            {!activeSchedules.length ? (
              <p className="p-8 text-center text-sm text-muted-foreground">No active schedules configured</p>
            ) : (
              <ScrollTable maxRows={VISIBLE_ROWS}>
                <table className="w-full text-sm table-modern">
                  <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                    <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-5 py-3 text-left font-medium">Name</th>
                      <th className="px-5 py-3 text-left font-medium">Status</th>
                      <th className="px-5 py-3 text-left font-medium">Cluster</th>
                      <th className="px-5 py-3 text-left font-medium">Namespace</th>
                      <th className="px-5 py-3 text-left font-medium">Target</th>
                      <th className="px-5 py-3 text-left font-medium">Shutdown</th>
                      <th className="px-5 py-3 text-left font-medium">Startup</th>
                      <th className="px-5 py-3 text-left font-medium">Next run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSchedules.map((s) => (
                      <tr key={s.id} className="border-b border-border">
                        <td className="px-5 py-3.5 font-medium text-foreground">{s.name}</td>
                        <td className="px-5 py-3.5">
                          <ScheduleStatusCell schedule={s} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ScheduleClusterCell cluster={s.cluster} />
                        </td>
                        <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{s.namespace}</td>
                        <td className="px-5 py-3.5">
                          <ScheduleTargetCell schedule={s} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ScheduleShutdownAtCell schedule={s} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ScheduleStartupAtCell schedule={s} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ScheduleNextRunCell schedule={s} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </GlassPanel>
        </>
      )}
    </div>
  );
}
