'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BadgeCheck,
  CircleAlert,
  CircleStop,
  Loader2,
  RefreshCcw,
  Workflow,
} from '@/lib/icons';
import {
  apiFetch,
  type ScheduleActivityTracker,
  type ScheduleActivityRow,
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
  accent,
}: {
  done: number;
  total: number;
  accent: 'emerald' | 'sky';
}) {
  const value = pct(done, total);
  const complete = total === 0 || done >= total;
  const barColor = complete
    ? 'bg-emerald-500'
    : accent === 'emerald'
      ? 'bg-emerald-500/70'
      : 'bg-sky-500/70';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full transition-all duration-500', barColor)}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function ServiceBadges({
  items,
  variant,
  limit = 8,
}: {
  items: string[];
  variant: 'applied' | 'pending';
  limit?: number;
}) {
  if (!items.length) return null;
  const shown = items.slice(0, limit);
  const tone =
    variant === 'applied'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return (
    <div className="flex flex-wrap gap-1 pt-0.5">
      {shown.map((item) => (
        <span
          key={item}
          className={cn('rounded-md px-1.5 py-0.5 font-mono text-[10px]', tone)}
        >
          {item}
        </span>
      ))}
      {items.length > limit ? (
        <span className="px-1 py-0.5 text-[10px] text-muted-foreground">
          +{items.length - limit} more
        </span>
      ) : null}
    </div>
  );
}

function MetricRow({
  label,
  done,
  total,
  pending,
  applied,
  accent,
  notResolved,
}: {
  label: string;
  done: number;
  total: number;
  pending: string[];
  applied?: string[];
  accent: 'emerald' | 'sky';
  notResolved?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {notResolved ? 'no linked Argo app' : `${done}/${total} · ${pct(done, total)}%`}
        </span>
      </div>
      <ProgressBar done={done} total={total} accent={accent} />
      {applied && applied.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground">
            Sync off ({applied.length})
          </p>
          <ServiceBadges items={applied} variant="applied" />
        </div>
      ) : null}
      {pending.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground">
            Pending ({pending.length})
          </p>
          <ServiceBadges items={pending} variant="pending" />
        </div>
      ) : null}
    </div>
  );
}

function StatusChip({ row }: { row: ScheduleActivityRow }) {
  if (row.error) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
        <CircleAlert className="h-3 w-3" strokeWidth={1.75} />
        Error
      </span>
    );
  }
  if (row.status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        <BadgeCheck className="h-3 w-3" strokeWidth={1.75} />
        Completed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
      <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />
      In progress
    </span>
  );
}

function ScheduleCard({ row }: { row: ScheduleActivityRow }) {
  const { clusterName } = parseClusterDisplay(row.cluster);
  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{row.name}</span>
            <StatusChip row={row} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="font-mono">{clusterName}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{row.namespace}</span>
            <span aria-hidden>·</span>
            <span className="capitalize">{row.scope}</span>
            {row.stoppedSince ? (
              <>
                <span aria-hidden>·</span>
                <span>stopped {formatRelativeTime(new Date(row.stoppedSince))}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {row.error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{row.error}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricRow
            label="Workloads stopped"
            done={row.stop.done}
            total={row.stop.total}
            pending={row.stop.pending}
            accent="emerald"
          />
          <MetricRow
            label="Manual sync off"
            done={row.syncOff.done}
            total={row.syncOff.total}
            pending={row.syncOff.pending}
            applied={row.syncOff.applied}
            accent="sky"
            notResolved={!row.syncOff.resolved}
          />
        </div>
      )}
    </div>
  );
}

function SyncOffServicesPanel({
  applied,
  pending,
}: {
  applied: ScheduleActivityTracker['syncOffServices'];
  pending: ScheduleActivityTracker['syncOffPendingServices'];
}) {
  if (!applied.length && !pending.length) return null;

  return (
    <GlassPanel>
      <PanelHeader title="Manual sync off — services" icon={Workflow} accent="blue" />
      <div className="grid gap-5 p-5 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-foreground">Sync off applied</p>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {applied.length} service{applied.length === 1 ? '' : 's'}
            </span>
          </div>
          {applied.length === 0 ? (
            <p className="text-xs text-muted-foreground">None yet</p>
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2">
              {applied.map((entry) => (
                <div
                  key={`${entry.scheduleId}:${entry.appName}`}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]"
                >
                  <span className="font-mono font-medium text-emerald-700 dark:text-emerald-300">
                    {entry.appName}
                  </span>
                  <span className="text-muted-foreground">
                    {entry.scheduleName} · {entry.namespace}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-foreground">Still pending sync off</p>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {pending.length} service{pending.length === 1 ? '' : 's'}
            </span>
          </div>
          {pending.length === 0 ? (
            <p className="text-xs text-muted-foreground">All linked services blocked</p>
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2">
              {pending.map((entry) => (
                <div
                  key={`${entry.scheduleId}:${entry.appName}`}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]"
                >
                  <span className="font-mono font-medium text-amber-700 dark:text-amber-300">
                    {entry.appName}
                  </span>
                  <span className="text-muted-foreground">
                    {entry.scheduleName} · {entry.namespace}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}

function OverallBar({ percent }: { percent: number }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          'h-full rounded-full transition-all duration-500',
          percent >= 100 ? 'bg-emerald-500' : 'bg-sky-500'
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function DashboardActivityTracker() {
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['activity-tracker'],
    queryFn: () => apiFetch<ScheduleActivityTracker>('/api/dashboard/activity-tracker'),
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals;

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.status !== b.status) return a.status === 'in-progress' ? -1 : 1;
        return b.ageMs - a.ageMs;
      }),
    [rows]
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activity tracker"
        description="Live stop & manual-sync-off progress for all currently stopped schedules — refreshed every 15s."
        action={
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <RefreshCcw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} strokeWidth={1.75} />
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      <GlassPanel>
        <PanelHeader title="Overall progress" icon={Activity} accent="blue" />
        <div className="space-y-3 p-5">
          {totals ? (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-semibold tabular-nums text-foreground">
                    {totals.percent}%
                  </span>
                  <span className="text-xs text-muted-foreground">complete</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <BadgeCheck className="h-3.5 w-3.5 text-emerald-500" strokeWidth={1.75} />
                  {totals.completed} completed
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 text-sky-500" strokeWidth={1.75} />
                  {totals.inProgress} in progress
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CircleStop className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {totals.stopDone}/{totals.stopTotal} workloads stopped
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Workflow className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {totals.syncDone}/{totals.syncTotal} sync-off applied
                </div>
              </div>
              <OverallBar percent={totals.percent} />
              {dataUpdatedAt > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  Updated {formatRelativeTime(new Date(dataUpdatedAt))}
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
        </div>
      </GlassPanel>

      <SyncOffServicesPanel
        applied={data?.syncOffServices ?? []}
        pending={data?.syncOffPendingServices ?? []}
      />

      {isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card/40 p-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : sortedRows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card/40 p-10 text-center">
          <BadgeCheck className="mx-auto mb-3 h-8 w-8 text-emerald-500" strokeWidth={1.5} />
          <p className="text-sm font-medium text-foreground">No stopped schedules</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No enabled schedules are currently in their stop window. When schedules stop, their
            workloads and manual sync-off status appear here.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sortedRows.map((row) => (
            <ScheduleCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
