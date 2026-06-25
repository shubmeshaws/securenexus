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

const POLL_INTERVAL_MS = 15_000;

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
  variant: 'completed' | 'pending';
}) {
  const value = pct(done, total);
  const complete = total === 0 || done >= total;
  const barColor =
    variant === 'completed'
      ? complete
        ? 'bg-emerald-500'
        : 'bg-emerald-500/70'
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

type ClusterGroups = Map<string, SyncOffNamespaceGroup[]>;

function groupByCluster(groups: SyncOffNamespaceGroup[]): ClusterGroups {
  const map: ClusterGroups = new Map();
  for (const group of groups) {
    const list = map.get(group.cluster) ?? [];
    list.push(group);
    map.set(group.cluster, list);
  }
  return map;
}

function ServiceList({
  services,
  variant,
}: {
  services: string[];
  variant: 'completed' | 'pending';
}) {
  if (!services.length) {
    return <p className="text-xs text-muted-foreground">None</p>;
  }
  const tone =
    variant === 'completed'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
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

function NamespaceGroupCard({
  group,
  mode,
}: {
  group: SyncOffNamespaceGroup;
  mode: 'completed' | 'pending';
}) {
  const { clusterName } = parseClusterDisplay(group.cluster);
  const services = mode === 'completed' ? group.completed : group.pending;

  if (mode === 'pending' && group.pendingCount === 0) return null;
  if (mode === 'completed' && group.completedCount === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/30 p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">{group.scheduleName}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {clusterName} · {group.namespace}
          </p>
        </div>
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          {mode === 'completed'
            ? `${group.completedCount}/${group.total} · ${group.percent}%`
            : `${group.pendingCount} pending`}
        </span>
      </div>
      <ProgressBar
        done={mode === 'completed' ? group.completedCount : group.completedCount}
        total={group.total}
        variant={mode}
      />
      <div className="mt-2.5 max-h-40 overflow-y-auto">
        <ServiceList services={services} variant={mode} />
      </div>
    </div>
  );
}

function SyncOffListPanel({
  title,
  mode,
  groups,
  overallDone,
  overallTotal,
}: {
  title: string;
  mode: 'completed' | 'pending';
  groups: SyncOffNamespaceGroup[];
  overallDone: number;
  overallTotal: number;
}) {
  const byCluster = useMemo(() => groupByCluster(groups), [groups]);

  const filteredGroups =
    mode === 'completed'
      ? groups.filter((g) => g.completedCount > 0)
      : groups.filter((g) => g.pendingCount > 0);

  const serviceCount =
    mode === 'completed'
      ? filteredGroups.reduce((n, g) => n + g.completedCount, 0)
      : filteredGroups.reduce((n, g) => n + g.pendingCount, 0);

  if (!filteredGroups.length) {
    return (
      <GlassPanel>
        <PanelHeader title={title} icon={Workflow} accent={mode === 'completed' ? 'emerald' : 'amber'} />
        <div className="p-5">
          <p className="text-sm text-muted-foreground">
            {mode === 'completed'
              ? 'No services have manual sync off applied yet.'
              : 'All scheduled services have manual sync off applied.'}
          </p>
        </div>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel>
      <PanelHeader title={title} icon={Workflow} accent={mode === 'completed' ? 'emerald' : 'amber'} />
      <div className="space-y-4 p-5">
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-foreground">
              {mode === 'completed' ? 'Overall completed' : 'Overall pending'}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {mode === 'completed'
                ? `${overallDone}/${overallTotal} · ${pct(overallDone, overallTotal)}%`
                : `${serviceCount} service${serviceCount === 1 ? '' : 's'}`}
            </span>
          </div>
          {mode === 'completed' ? (
            <ProgressBar done={overallDone} total={overallTotal} variant="completed" />
          ) : (
            <ProgressBar
              done={overallTotal - serviceCount}
              total={overallTotal}
              variant="pending"
            />
          )}
        </div>

        {Array.from(byCluster.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([cluster, clusterGroups]) => {
            const { clusterName } = parseClusterDisplay(cluster);
            const visible = clusterGroups.filter((g) =>
              mode === 'completed' ? g.completedCount > 0 : g.pendingCount > 0
            );
            if (!visible.length) return null;

            const clusterDone =
              mode === 'completed'
                ? visible.reduce((n, g) => n + g.completedCount, 0)
                : visible.reduce((n, g) => n + g.pendingCount, 0);
            const clusterTotal =
              mode === 'completed'
                ? visible.reduce((n, g) => n + g.total, 0)
                : visible.reduce((n, g) => n + g.pendingCount, 0);

            return (
              <div key={cluster} className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {clusterName}
                    </h3>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {mode === 'completed'
                        ? `${clusterDone}/${clusterTotal}`
                        : `${clusterDone} pending`}
                    </span>
                  </div>
                  {mode === 'completed' ? (
                    <ProgressBar done={clusterDone} total={clusterTotal} variant="completed" />
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {visible.map((group) => (
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
    refetchOnWindowFocus: true,
  });

  const groups = data?.syncOffGroups ?? [];
  const totals = data?.totals;
  const hasActivity = groups.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activity tracker"
        description="Manual sync off status for stopped schedules — grouped by cluster and namespace. Only scheduled workload services are listed."
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
          <p className="text-sm font-medium text-foreground">No stopped schedules</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No schedules are currently in their stop window. Manual sync off lists appear here
            during downtime.
          </p>
        </div>
      ) : (
        <>
          {dataUpdatedAt > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Updated {formatRelativeTime(new Date(dataUpdatedAt))} ·{' '}
              {totals?.schedules ?? 0} schedule{(totals?.schedules ?? 0) === 1 ? '' : 's'} tracked
            </p>
          ) : null}

          <SyncOffListPanel
            title="Manual sync off services — completed"
            mode="completed"
            groups={groups}
            overallDone={totals?.syncDone ?? 0}
            overallTotal={totals?.syncTotal ?? 0}
          />

          <SyncOffListPanel
            title="Manual sync off services — pending"
            mode="pending"
            groups={groups}
            overallDone={totals?.syncDone ?? 0}
            overallTotal={totals?.syncTotal ?? 0}
          />
        </>
      )}
    </div>
  );
}
