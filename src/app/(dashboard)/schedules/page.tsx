'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarRange,
  CirclePlay,
  CircleStop,
  Icons,
  Loader2,
  PenLine,
  ScanSearch,
  Trash2,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch, type Schedule } from '@/lib/api-client';
import { scheduleLiveQueryOptions } from '@/components/providers/query-provider';
import { filterSchedulesByQuery } from '@/lib/schedule-search';
import { cn, parseClusterDisplay } from '@/lib/utils';
import {
  DashboardFilterBar,
  DashboardFilterSelect,
} from '@/components/dashboard/dashboard-filters';
import { ScheduleFormDrawer } from '@/components/pod-scheduler/schedule-form-drawer';
import { ScheduleDetailDrawer } from '@/components/pod-scheduler/schedule-detail-drawer';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { PageHeader, GlassPanel } from '@/components/pod-scheduler/ui-primitives';
import { usePermissions } from '@/components/auth/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ScheduleClusterCell,
  ScheduleAccountIdCell,
  ScheduleEnvironmentCell,
  ScheduleTargetCell,
  ScheduleNextRunCell,
  ScheduleShutdownAtCell,
  ScheduleStartupAtCell,
  ScheduleRepeatsCell,
  ScheduleStatusCell,
} from '@/components/pod-scheduler/schedule-table-cells';

type ScheduleStatusKey = 'stopped' | 'completed' | 'enabled' | 'disabled';

const STATUS_FILTER_OPTIONS: { value: ScheduleStatusKey; label: string }[] = [
  { value: 'enabled', label: 'Enabled' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'completed', label: 'Completed' },
];

function scheduleStatusKey(s: Schedule): ScheduleStatusKey {
  if (s.liveActive) return 'stopped';
  if (s.oneTimeCompleted) return 'completed';
  return s.enabled ? 'enabled' : 'disabled';
}

function scheduleAccountId(s: Schedule): string {
  return s.awsAccountId ?? parseClusterDisplay(s.cluster).accountId ?? '';
}

export default function SchedulesPage() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [detailSchedule, setDetailSchedule] = useState<Schedule | null>(null);
  const [scheduleToDelete, setScheduleToDelete] = useState<Schedule | null>(null);
  const [runSchedule, setRunSchedule] = useState<{ id: string; mode: 'shutdown' | 'startup' } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [clusterFilter, setClusterFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => apiFetch<{ schedules: Schedule[] }>('/api/schedules'),
    ...scheduleLiveQueryOptions,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['schedules-live'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      setScheduleToDelete(null);
    },
  });

  const runMutation = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'shutdown' | 'startup' }) =>
      apiFetch(`/api/schedules/${id}/run`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['schedules-live'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      setRunSchedule(null);
    },
  });

  const schedules = data?.schedules ?? [];

  const clusterOptions = useMemo(
    () =>
      Array.from(new Set(schedules.map((s) => s.cluster).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [schedules]
  );
  const accountOptions = useMemo(
    () =>
      Array.from(new Set(schedules.map(scheduleAccountId).filter(Boolean))).sort((a, b) =>
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

  const filtersActive = Boolean(
    searchQuery || clusterFilter || accountFilter || namespaceFilter || statusFilter
  );

  const filteredSchedules = useMemo(() => {
    let list = filterSchedulesByQuery(schedules, searchQuery);
    if (clusterFilter) list = list.filter((s) => s.cluster === clusterFilter);
    if (accountFilter) list = list.filter((s) => scheduleAccountId(s) === accountFilter);
    if (namespaceFilter) list = list.filter((s) => s.namespace === namespaceFilter);
    if (statusFilter) list = list.filter((s) => scheduleStatusKey(s) === statusFilter);
    return list;
  }, [schedules, searchQuery, clusterFilter, accountFilter, namespaceFilter, statusFilter]);

  function scheduleRowClass(schedule: Schedule) {
    const isManual = schedule.platformType === 'non_eks';
    return cn(
      'cursor-pointer border-b border-border transition-colors hover:bg-muted/30',
      schedule.liveActive &&
        'bg-red-500/[0.04] hover:bg-red-500/[0.07] [&>td:first-child]:shadow-[inset_3px_0_0_0_rgb(239,68,68)]',
      !schedule.liveActive &&
        isManual &&
        'bg-sky-500/[0.07] hover:bg-sky-500/[0.1] dark:bg-sky-500/10 dark:hover:bg-sky-500/15 [&>td:first-child]:shadow-[inset_3px_0_0_0_rgb(14,165,233)]',
      !schedule.liveActive &&
        !isManual &&
        'bg-amber-500/[0.07] hover:bg-amber-500/[0.1] dark:bg-amber-500/10 dark:hover:bg-amber-500/15 [&>td:first-child]:shadow-[inset_3px_0_0_0_rgb(245,158,11)]'
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedules"
        description="Configure automated start/stop windows for your EKS infrastructure."
        action={
          permissions.scheduleEdit ? (
            <Button
              size="sm"
              onClick={() => {
                setEditSchedule(null);
                setDrawerOpen(true);
              }}
            >
              <AppIcon icon={Icons.actions.add} size="sm" />
              Add Schedule
            </Button>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
        </div>
      ) : (
        <GlassPanel>
          <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <AppIcon icon={CalendarRange} size="sm" className="text-blue-500" />
              <h2 className="text-sm font-semibold text-foreground">All Schedules</h2>
            </div>
            <div className="relative w-full sm:max-w-xs">
              <AppIcon
                icon={ScanSearch}
                size="sm"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search schedules…"
                className="pl-9"
                aria-label="Search schedules"
              />
            </div>
          </div>
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
                {STATUS_FILTER_OPTIONS.map((opt) => (
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
                    setSearchQuery('');
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
          <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-3 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 leading-none">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-sky-500/40" />
              <span>Manual (Non-EKS / EC2)</span>
            </span>
            <span className="inline-flex items-center gap-1.5 leading-none">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500/40" />
              <span>EKS</span>
            </span>
            <span className="text-muted-foreground/80">· Click a row to view details</span>
          </div>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm table-modern">
              <thead>
                <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3 text-left font-medium">Name</th>
                  <th className="px-5 py-3 text-left font-medium">Cluster</th>
                  <th className="px-5 py-3 text-left font-medium">Account ID</th>
                  <th className="px-5 py-3 text-left font-medium">Environment</th>
                  <th className="px-5 py-3 text-left font-medium">Namespace</th>
                  <th className="px-5 py-3 text-left font-medium">Target</th>
                  <th className="px-5 py-3 text-left font-medium">Shutdown</th>
                  <th className="px-5 py-3 text-left font-medium whitespace-nowrap">Startup</th>
                  <th className="px-5 py-3 text-left font-medium">Repeats</th>
                  <th className="px-5 py-3 text-left font-medium">Status</th>
                  <th className="px-5 py-3 text-left font-medium">Next run</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.length === 0 && (
                  <tr>
                    <td colSpan={12} className="p-8 text-center text-muted-foreground">
                      No schedules configured
                    </td>
                  </tr>
                )}
                {schedules.length > 0 && filteredSchedules.length === 0 && (
                  <tr>
                    <td colSpan={12} className="p-8 text-center text-muted-foreground">
                      {searchQuery
                        ? <>No schedules match &ldquo;{searchQuery}&rdquo;</>
                        : 'No schedules match the selected filters'}
                    </td>
                  </tr>
                )}
                {filteredSchedules.map((s) => (
                  <tr
                    key={s.id}
                    className={scheduleRowClass(s)}
                    onClick={() => setDetailSchedule(s)}
                  >
                    <td className="px-5 py-3.5 font-medium text-foreground">{s.name}</td>
                    <td className="px-5 py-3.5">
                      <ScheduleClusterCell cluster={s.cluster} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleAccountIdCell cluster={s.cluster} awsAccountId={s.awsAccountId} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleEnvironmentCell cluster={s.cluster} namespace={s.namespace} />
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{s.namespace}</td>
                    <td className="px-5 py-3.5">
                      <ScheduleTargetCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleShutdownAtCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <ScheduleStartupAtCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleRepeatsCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleStatusCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleNextRunCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end">
                        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card/60 p-1 shadow-sm">
                          {permissions.scheduleStop && (
                            <button
                              type="button"
                              title="Run shutdown now"
                              aria-label="Run shutdown now"
                              onClick={() => setRunSchedule({ id: s.id, mode: 'shutdown' })}
                              className="inline-flex items-center justify-center rounded-md p-1.5 text-rose-600 transition-colors duration-200 hover:bg-rose-500/15 focus:outline-none focus:ring-2 focus:ring-rose-500/30 dark:text-rose-400"
                            >
                              <AppIcon icon={CircleStop} size="sm" />
                            </button>
                          )}
                          {permissions.scheduleStart && (
                            <button
                              type="button"
                              title="Run startup now"
                              aria-label="Run startup now"
                              onClick={() => setRunSchedule({ id: s.id, mode: 'startup' })}
                              className="inline-flex items-center justify-center rounded-md p-1.5 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/15 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 dark:text-emerald-400"
                            >
                              <AppIcon icon={CirclePlay} size="sm" />
                            </button>
                          )}
                          {permissions.scheduleEdit && (
                            <>
                              <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
                              <button
                                type="button"
                                title="Edit schedule"
                                aria-label="Edit schedule"
                                onClick={() => {
                                  setEditSchedule(s);
                                  setDrawerOpen(true);
                                }}
                                className="inline-flex items-center justify-center rounded-md p-1.5 text-blue-600 transition-colors duration-200 hover:bg-blue-500/15 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:text-blue-400"
                              >
                                <AppIcon icon={PenLine} size="sm" />
                              </button>
                              <button
                                type="button"
                                title="Delete schedule"
                                aria-label="Delete schedule"
                                onClick={() => setScheduleToDelete(s)}
                                className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors duration-200 hover:bg-rose-500/15 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-rose-500/30 dark:hover:text-rose-400"
                              >
                                <AppIcon icon={Trash2} size="sm" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      )}

      <ScheduleDetailDrawer
        open={detailSchedule !== null}
        onClose={() => setDetailSchedule(null)}
        schedule={detailSchedule}
        canEdit={permissions.scheduleEdit}
        canStart={permissions.scheduleStart}
        canStop={permissions.scheduleStop}
        onEdit={(schedule) => {
          setDetailSchedule(null);
          setEditSchedule(schedule);
          setDrawerOpen(true);
        }}
        onRun={(schedule, mode) => {
          setDetailSchedule(null);
          setRunSchedule({ id: schedule.id, mode });
        }}
        onDelete={(schedule) => {
          setDetailSchedule(null);
          setScheduleToDelete(schedule);
        }}
      />

      <ScheduleFormDrawer
        key={editSchedule?.id ?? 'new-schedule'}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditSchedule(null);
        }}
        schedule={editSchedule}
      />

      <ConfirmDialog
        open={scheduleToDelete !== null}
        onOpenChange={(open) => !open && setScheduleToDelete(null)}
        title="Delete schedule?"
        description={
          <>
            Permanently delete <span className="font-medium text-foreground">{scheduleToDelete?.name}</span>?
            This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => scheduleToDelete && deleteMutation.mutate(scheduleToDelete.id)}
        loading={deleteMutation.isPending}
      />

      <Dialog open={runSchedule !== null} onOpenChange={() => setRunSchedule(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run schedule now?</DialogTitle>
            <DialogDescription>
              Execute {runSchedule?.mode} action immediately for this schedule.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunSchedule(null)}>Cancel</Button>
            <Button
              onClick={() => runSchedule && runMutation.mutate(runSchedule)}
              disabled={runMutation.isPending}
            >
              Run now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
