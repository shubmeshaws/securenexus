'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Activity, CircleStop, Icons, Loader2 } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { formatRelativeTime, parseClusterDisplay } from '@/lib/utils';
import {
  DashboardFilterBar,
  DashboardFilterSelect,
} from '@/components/dashboard/dashboard-filters';
import { scheduleLiveQueryOptions } from '@/components/providers/query-provider';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { usePermissions } from '@/components/auth/session-context';
import { PageHeader, GlassPanel, PanelHeader, EmptyState } from '@/components/pod-scheduler/ui-primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CountdownTimer } from '@/components/pod-scheduler/countdown-timer';
import {
  ScheduleClusterCell,
  ScheduleTargetCell,
  ScheduleNextRunCell,
  ScheduleShutdownAtCell,
  ScheduleStartupAtCell,
  ScheduleRepeatsCell,
} from '@/components/pod-scheduler/schedule-table-cells';

interface LiveScheduleItem {
  id: string;
  name: string;
  cluster: string;
  namespace: string;
  scope: 'workload' | 'namespace';
  appName: string;
  workloadKind: string;
  excludedWorkloads: string[];
  shutdownTime: string;
  startupTime: string;
  weekendShutdownTime: string | null;
  weekendStartupTime: string | null;
  weekendDays: number[];
  recurrence: 'daily' | 'onetime' | 'split';
  oneTimeShutdownAt: string | null;
  oneTimeStartupAt: string | null;
  timezone: string;
  daysOfWeek: number[];
  lastRun: string | null;
  nextRun: string | null;
  startupAt: string | null;
  message: string;
}

interface LiveSchedulesResponse {
  schedules: LiveScheduleItem[];
  total: number;
  checkedAt: string;
}

type LiveScheduleStatusKey = 'stopped' | 'completed' | 'enabled' | 'disabled';

function liveScheduleAccountId(schedule: LiveScheduleItem): string {
  return parseClusterDisplay(schedule.cluster).accountId ?? '';
}

function liveScheduleStatusKey(_schedule: LiveScheduleItem): LiveScheduleStatusKey {
  return 'stopped';
}

const LIVE_STATUS_FILTER_OPTIONS: { value: LiveScheduleStatusKey; label: string }[] = [
  { value: 'enabled', label: 'Enabled' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'completed', label: 'Completed' },
];

export function ActiveSchedulesContent() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const [scheduleToStop, setScheduleToStop] = useState<LiveScheduleItem | null>(null);
  const [clusterFilter, setClusterFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['schedules-live'],
    queryFn: () => apiFetch<LiveSchedulesResponse>('/api/schedules/live'),
    ...scheduleLiveQueryOptions,
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/schedules/${id}/live-stop`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules-live'] });
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      setScheduleToStop(null);
    },
  });

  const schedules = data?.schedules ?? [];
  const total = data?.total ?? 0;

  const clusterOptions = useMemo(
    () =>
      Array.from(new Set(schedules.map((s) => s.cluster).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [schedules]
  );
  const accountOptions = useMemo(
    () =>
      Array.from(new Set(schedules.map(liveScheduleAccountId).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [schedules]
  );
  const namespaceOptions = useMemo(
    () =>
      Array.from(new Set(schedules.map((s) => s.namespace).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [schedules]
  );

  const filtersActive = Boolean(clusterFilter || accountFilter || namespaceFilter || statusFilter);

  const filteredSchedules = useMemo(() => {
    let list = schedules;
    if (clusterFilter) list = list.filter((s) => s.cluster === clusterFilter);
    if (accountFilter) list = list.filter((s) => liveScheduleAccountId(s) === accountFilter);
    if (namespaceFilter) list = list.filter((s) => s.namespace === namespaceFilter);
    if (statusFilter) list = list.filter((s) => liveScheduleStatusKey(s) === statusFilter);
    return list;
  }, [schedules, clusterFilter, accountFilter, namespaceFilter, statusFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Schedules"
        description="Deployments in the stopped window (shutdown → startup). Stop early here; start only from Schedules."
        action={
          <Button size="sm" variant="outline" asChild>
            <Link href="/schedules">
              <AppIcon icon={Icons.pages.schedules} size="sm" />
              All Schedules
            </Link>
          </Button>
        }
      />

      <GlassPanel className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80 dark:bg-emerald-500/15 dark:text-emerald-400 dark:ring-0">
          <AppIcon icon={Activity} />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">In stopped window</p>
          <p className="text-lg font-semibold text-foreground">
            {filtersActive ? filteredSchedules.length : total}
            {filtersActive && filteredSchedules.length !== total ? (
              <span className="ml-1 text-sm font-normal text-muted-foreground">/ {total}</span>
            ) : null}
          </p>
        </div>
      </GlassPanel>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
        </div>
      ) : total === 0 ? (
        <GlassPanel>
          <EmptyState
            icon={CircleStop}
            title="No live schedules"
            description="A schedule appears here after shutdown runs, while waiting until the next startup time. It is removed automatically when startup executes."
            action={
              <Button size="sm" asChild>
                <Link href="/schedules">Go to Schedules</Link>
              </Button>
            }
          />
        </GlassPanel>
      ) : (
        <GlassPanel>
          <PanelHeader title="Stopped & waiting for startup" icon={CircleStop} />
          <div className="border-b border-border px-5 py-3">
            <DashboardFilterBar>
              <DashboardFilterSelect
                value={clusterFilter}
                onChange={(e) => setClusterFilter(e.target.value)}
                aria-label="Filter by cluster"
                title="Filter by cluster"
              >
                <option value="">All clusters</option>
                {clusterOptions.map((c) => (
                  <option key={c} value={c}>
                    {parseClusterDisplay(c).clusterName}
                  </option>
                ))}
              </DashboardFilterSelect>
              <DashboardFilterSelect
                value={accountFilter}
                onChange={(e) => setAccountFilter(e.target.value)}
                aria-label="Filter by account ID"
                title="Filter by account ID"
              >
                <option value="">All account IDs</option>
                {accountOptions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </DashboardFilterSelect>
              <DashboardFilterSelect
                value={namespaceFilter}
                onChange={(e) => setNamespaceFilter(e.target.value)}
                aria-label="Filter by namespace"
                title="Filter by namespace"
              >
                <option value="">All namespaces</option>
                {namespaceOptions.map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </DashboardFilterSelect>
              <DashboardFilterSelect
                width="sm"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by status"
                title="Filter by status"
              >
                <option value="">All statuses</option>
                {LIVE_STATUS_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </DashboardFilterSelect>
              {filtersActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-[11px] text-muted-foreground"
                  onClick={() => {
                    setClusterFilter('');
                    setAccountFilter('');
                    setNamespaceFilter('');
                    setStatusFilter('');
                  }}
                >
                  Clear filters
                </Button>
              )}
            </DashboardFilterBar>
          </div>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm table-modern">
              <thead>
                <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3 text-left font-medium">Name</th>
                  <th className="px-5 py-3 text-left font-medium">Cluster</th>
                  <th className="px-5 py-3 text-left font-medium">Namespace</th>
                  <th className="px-5 py-3 text-left font-medium">Target</th>
                  <th className="px-5 py-3 text-left font-medium">Status</th>
                  <th className="px-5 py-3 text-left font-medium">Stopped window</th>
                  <th className="px-5 py-3 text-left font-medium">Days</th>
                  <th className="px-5 py-3 text-left font-medium">Time remaining</th>
                  <th className="px-5 py-3 text-left font-medium">Startup at</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredSchedules.length === 0 && (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-muted-foreground">
                      No live schedules match the selected filters
                    </td>
                  </tr>
                )}
                {filteredSchedules.map((schedule) => (
                  <tr key={schedule.id} className="border-b border-border">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                        </span>
                        <span className="font-medium text-foreground">{schedule.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleClusterCell cluster={schedule.cluster} />
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">
                      {schedule.namespace}
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleTargetCell schedule={schedule} />
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge variant="success">Stopped</Badge>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">
                      <ScheduleShutdownAtCell
                        schedule={{
                          recurrence: schedule.recurrence,
                          shutdownTime: schedule.shutdownTime,
                          weekendShutdownTime: schedule.weekendShutdownTime,
                          weekendDays: schedule.weekendDays,
                          daysOfWeek: schedule.daysOfWeek,
                          oneTimeShutdownAt: schedule.oneTimeShutdownAt,
                          timezone: schedule.timezone,
                        }}
                      />
                      {' → '}
                      <ScheduleStartupAtCell
                        schedule={{
                          recurrence: schedule.recurrence,
                          startupTime: schedule.startupTime,
                          weekendStartupTime: schedule.weekendStartupTime,
                          weekendDays: schedule.weekendDays,
                          daysOfWeek: schedule.daysOfWeek,
                          oneTimeStartupAt: schedule.oneTimeStartupAt,
                          timezone: schedule.timezone,
                        }}
                      />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleRepeatsCell
                        schedule={{
                          recurrence: schedule.recurrence,
                          daysOfWeek: schedule.daysOfWeek,
                          oneTimeCompleted: false,
                          enabled: true,
                        }}
                      />
                    </td>
                    <td className="px-5 py-3.5">
                      {schedule.startupAt ? (
                        <CountdownTimer targetIso={schedule.startupAt} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleNextRunCell
                        schedule={{
                          nextRun: schedule.startupAt ?? schedule.nextRun,
                          timezone: schedule.timezone,
                        }}
                      />
                    </td>
                    <td className="px-5 py-3.5">
                      {permissions.liveScheduleStop ? (
                        <div className="flex items-center justify-end">
                          <Button
                            variant="danger"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => setScheduleToStop(schedule)}
                            disabled={stopMutation.isPending}
                          >
                            <AppIcon icon={CircleStop} size="sm" />
                            Stop
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      )}

      {dataUpdatedAt > 0 && (
        <p className="text-center text-[10px] text-muted-foreground">
          Refreshes automatically · last checked {formatRelativeTime(new Date(dataUpdatedAt))}
        </p>
      )}

      <ConfirmDialog
        open={scheduleToStop !== null}
        onOpenChange={(open) => !open && setScheduleToStop(null)}
        title="Stop live schedule?"
        description={
          scheduleToStop ? (
            <>
              Shut down <span className="font-medium text-foreground">{scheduleToStop.name}</span> now and
              remove it from Live Schedules? Use Schedules page to start it again later.
            </>
          ) : null
        }
        confirmLabel="Stop now"
        onConfirm={() => scheduleToStop && stopMutation.mutate(scheduleToStop.id)}
        loading={stopMutation.isPending}
        destructive
      />
    </div>
  );
}
