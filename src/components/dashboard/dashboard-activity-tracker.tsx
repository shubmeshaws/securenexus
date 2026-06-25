'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  CircleAlert,
  Loader2,
  RefreshCcw,
  Workflow,
} from '@/lib/icons';
import {
  apiFetch,
  type ScheduleActivityTracker,
  type SyncOffNamespaceGroup,
} from '@/lib/api-client';
import { GlassPanel, PageHeader, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { formatRelativeTime, parseClusterDisplay, cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 120_000;

type ListMode = 'blocked' | 'sync-on-downtime' | 'sync-on-expected';

function pct(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((done / total) * 100);
}

function ProgressBar({
  done,
  total,
  variant,
}: {
  done: number;
  total: number;
  variant: 'emerald' | 'amber' | 'sky';
}) {
  const value = pct(done, total);
  const complete = total === 0 || done >= total;
  const barColor =
    variant === 'emerald'
      ? complete
        ? 'bg-emerald-500'
        : 'bg-emerald-500/70'
      : variant === 'sky'
        ? 'bg-sky-500/70'
        : complete
          ? 'bg-emerald-500'
          : 'bg-amber-500/80';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full transition-all duration-500', barColor)}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function servicesForMode(group: SyncOffNamespaceGroup, mode: ListMode): string[] {
  if (mode === 'blocked') return group.completed;
  if (mode === 'sync-on-downtime') return group.syncOnDuringDowntime;
  return group.syncOnExpected;
}

function countForMode(group: SyncOffNamespaceGroup, mode: ListMode): number {
  if (mode === 'blocked') return group.completedCount;
  if (mode === 'sync-on-downtime') return group.syncOnDuringDowntimeCount;
  return group.syncOnExpectedCount;
}

function groupByCluster(groups: SyncOffNamespaceGroup[]): Map<string, SyncOffNamespaceGroup[]> {
  const map = new Map<string, SyncOffNamespaceGroup[]>();
  for (const group of groups) {
    const list = map.get(group.cluster) ?? [];
    list.push(group);
    map.set(group.cluster, list);
  }
  return map;
}

function ServiceList({ services, mode }: { services: string[]; mode: ListMode }) {
  if (!services.length) {
    return <p className="text-xs text-muted-foreground">None</p>;
  }
  const tone =
    mode === 'blocked'
      ? 'bg-red-500/10 text-red-700 dark:text-red-300'
      : mode === 'sync-on-downtime'
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return (
    <div className="flex flex-wrap gap-1.5">
      {services.map((name) => (
        <span key={name} className={cn('rounded-md px-2 py-0.5 font-mono text-[10px]', tone)}>
          {name}
        </span>
      ))}
    </div>
  );
}

function NamespaceGroupCard({ group, mode }: { group: SyncOffNamespaceGroup; mode: ListMode }) {
  const { clusterName } = parseClusterDisplay(group.cluster);
  const services = servicesForMode(group, mode);
  const count = countForMode(group, mode);

  if (count === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/30 p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-semibold text-foreground">{group.scheduleName}</p>
            {mode === 'blocked' && group.lingeringSyncOff ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-300">
                <CircleAlert className="h-2.5 w-2.5" strokeWidth={2} />
                Outside stop window
              </span>
            ) : group.inStopWindow ? (
              <span className="rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-600 dark:text-sky-400">
                In downtime
              </span>
            ) : (
              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                Running hours
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {clusterName} · {group.namespace}
          </p>
        </div>
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          {mode === 'blocked'
            ? `${count}/${group.total} · ${group.percent}%`
            : `${count} service${count === 1 ? '' : 's'}`}
        </span>
      </div>
      {mode === 'blocked' ? (
        <ProgressBar done={count} total={group.total} variant="emerald" />
      ) : mode === 'sync-on-downtime' ? (
        <ProgressBar done={group.completedCount} total={group.total} variant="amber" />
      ) : null}
      <div className="mt-2.5 max-h-40 overflow-y-auto">
        <ServiceList services={services} mode={mode} />
      </div>
    </div>
  );
}

function SyncListPanel({
  title,
  subtitle,
  mode,
  groups,
  overallDone,
  overallTotal,
  emptyMessage,
}: {
  title: string;
  subtitle: string;
  mode: ListMode;
  groups: SyncOffNamespaceGroup[];
  overallDone?: number;
  overallTotal?: number;
  emptyMessage: string;
}) {
  const byCluster = useMemo(() => groupByCluster(groups), [groups]);
  const visible = groups.filter((g) => countForMode(g, mode) > 0);
  const serviceCount = visible.reduce((n, g) => n + countForMode(g, mode), 0);

  const accent: 'emerald' | 'amber' | 'sky' =
    mode === 'blocked' ? 'emerald' : mode === 'sync-on-downtime' ? 'amber' : 'sky';

  if (!visible.length) {
    return (
      <GlassPanel>
        <PanelHeader title={title} icon={Workflow} accent={accent} />
        <div className="space-y-1 p-5">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel>
      <PanelHeader title={title} icon={Workflow} accent={accent} />
      <div className="space-y-4 p-5">
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>

        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-foreground">Overall</span>
            <span className="tabular-nums text-muted-foreground">
              {mode === 'blocked' && overallDone != null && overallTotal != null
                ? `${overallDone}/${overallTotal} · ${pct(overallDone, overallTotal)}%`
                : `${serviceCount} service${serviceCount === 1 ? '' : 's'}`}
            </span>
          </div>
          {mode === 'blocked' && overallDone != null && overallTotal != null ? (
            <ProgressBar done={overallDone} total={overallTotal} variant="emerald" />
          ) : mode === 'sync-on-downtime' && overallTotal != null ? (
            <ProgressBar
              done={(overallTotal ?? 0) - serviceCount}
              total={overallTotal ?? 0}
              variant="amber"
            />
          ) : null}
        </div>

        {Array.from(byCluster.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([cluster, clusterGroups]) => {
            const { clusterName } = parseClusterDisplay(cluster);
            const clusterVisible = clusterGroups.filter((g) => countForMode(g, mode) > 0);
            if (!clusterVisible.length) return null;

            const clusterCount = clusterVisible.reduce((n, g) => n + countForMode(g, mode), 0);
            const clusterTotal =
              mode === 'blocked'
                ? clusterVisible.reduce((n, g) => n + g.total, 0)
                : clusterCount;

            return (
              <div key={cluster} className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {clusterName}
                    </h3>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {mode === 'blocked'
                        ? `${clusterCount}/${clusterTotal}`
                        : `${clusterCount} service${clusterCount === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  {mode === 'blocked' ? (
                    <ProgressBar done={clusterCount} total={clusterTotal} variant="emerald" />
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {clusterVisible.map((group) => (
                    <NamespaceGroupCard key={group.scheduleId} group={group} mode={mode} />
                  ))}
                </div>
              </div>
            );
          })}
      </div>
    </GlassPanel>
  );
}

export function DashboardActivityTracker() {
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['activity-tracker'],
    queryFn: () => apiFetch<ScheduleActivityTracker>('/api/dashboard/activity-tracker'),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 90_000,
  });

  const groups = data?.syncOffGroups ?? [];
  const totals = data?.totals;
  const hasActivity = groups.length > 0;
  const hasDowntimeSchedules = groups.some((g) => g.inStopWindow);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activity tracker"
        description="Two-way manual sync visibility: who is blocked (sync off) and who is still enabled (sync on) — during downtime and outside it."
        action={
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <RefreshCcw
              className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')}
              strokeWidth={1.75}
            />
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card/40 p-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !hasActivity ? (
        <div className="rounded-xl border border-border bg-card/40 p-10 text-center">
          <BadgeCheck className="mx-auto mb-3 h-8 w-8 text-emerald-500" strokeWidth={1.5} />
          <p className="text-sm font-medium text-foreground">No manual sync activity</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No sync-off windows are active and no schedules are in downtime. Stuck windows or
            downtime gaps will appear here automatically.
          </p>
        </div>
      ) : (
        <>
          {(totals?.lingeringSchedules ?? 0) > 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
              <div>
                <p className="font-medium">
                  {totals?.lingeringSchedules} schedule
                  {(totals?.lingeringSchedules ?? 0) === 1 ? '' : 's'} have manual sync OFF outside
                  the stop window
                </p>
                <p className="mt-0.5 text-xs opacity-90">
                  Sync should be enabled again during running hours. These need cleanup.
                </p>
              </div>
            </div>
          ) : null}

          {(totals?.syncOnDuringDowntime ?? 0) > 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
              <div>
                <p className="font-medium">
                  {totals?.syncOnDuringDowntime} service
                  {(totals?.syncOnDuringDowntime ?? 0) === 1 ? '' : 's'} still have manual sync ON
                  during downtime
                </p>
                <p className="mt-0.5 text-xs opacity-90">
                  These should be blocked (sync off) but deny windows are missing.
                </p>
              </div>
            </div>
          ) : null}

          {dataUpdatedAt > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Updated {formatRelativeTime(new Date(dataUpdatedAt))} ·{' '}
              {totals?.schedules ?? 0} schedule{(totals?.schedules ?? 0) === 1 ? '' : 's'} tracked
              {hasDowntimeSchedules ? ' · some in downtime' : ' · running hours'}
            </p>
          ) : null}

          <SyncListPanel
            title="Manual sync OFF (blocked)"
            subtitle="Services with deny window applied — sync is blocked."
            mode="blocked"
            groups={groups}
            overallDone={totals?.syncDone ?? 0}
            overallTotal={totals?.syncTotal ?? 0}
            emptyMessage="No services currently have manual sync off applied."
          />

          <SyncListPanel
            title="Manual sync ON during downtime"
            subtitle="Services still enabled during stop window — should be blocked but are not."
            mode="sync-on-downtime"
            groups={groups}
            overallTotal={totals?.syncTotal ?? 0}
            emptyMessage={
              hasDowntimeSchedules
                ? 'All scheduled services are blocked during downtime.'
                : 'No schedules are currently in their stop window.'
            }
          />

          <SyncListPanel
            title="Manual sync ON during running hours"
            subtitle="Services correctly unblocked outside the stop window — expected state."
            mode="sync-on-expected"
            groups={groups}
            emptyMessage="No running-hour schedules tracked, or all are still in downtime."
          />
        </>
      )}
    </div>
  );
}
