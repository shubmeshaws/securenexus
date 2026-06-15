'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarRange,
  CirclePlay,
  CircleStop,
  Icons,
  Loader2,
  PenLine,
  Trash2,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch, type Schedule } from '@/lib/api-client';
import { scheduleLiveQueryOptions } from '@/components/providers/query-provider';
import { cn } from '@/lib/utils';
import { ScheduleFormDrawer } from '@/components/pod-scheduler/schedule-form-drawer';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { PageHeader, GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { usePermissions } from '@/components/auth/session-context';
import { Button } from '@/components/ui/button';
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

export default function SchedulesPage() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [scheduleToDelete, setScheduleToDelete] = useState<Schedule | null>(null);
  const [runSchedule, setRunSchedule] = useState<{ id: string; mode: 'shutdown' | 'startup' } | null>(null);

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
          <PanelHeader title="All Schedules" icon={CalendarRange} />
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
                  <th className="px-5 py-3 text-left font-medium">Timezone</th>
                  <th className="px-5 py-3 text-left font-medium">Repeats</th>
                  <th className="px-5 py-3 text-left font-medium">Status</th>
                  <th className="px-5 py-3 text-left font-medium">Next run</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.length === 0 && (
                  <tr>
                    <td colSpan={13} className="p-8 text-center text-muted-foreground">
                      No schedules configured
                    </td>
                  </tr>
                )}
                {schedules.map((s) => (
                  <tr
                    key={s.id}
                    className={cn(
                      'border-b border-border',
                      s.liveActive && 'bg-red-500/[0.04] [&>td:first-child]:shadow-[inset_3px_0_0_0_rgb(239,68,68)]'
                    )}
                  >
                    <td className="px-5 py-3.5 font-medium text-foreground">{s.name}</td>
                    <td className="px-5 py-3.5">
                      <ScheduleClusterCell cluster={s.cluster} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleAccountIdCell cluster={s.cluster} />
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
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{s.timezone}</td>
                    <td className="px-5 py-3.5">
                      <ScheduleRepeatsCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleStatusCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5">
                      <ScheduleNextRunCell schedule={s} />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1">
                        {permissions.scheduleStop && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Run shutdown now"
                            onClick={() => setRunSchedule({ id: s.id, mode: 'shutdown' })}
                          >
                            <AppIcon icon={CircleStop} size="sm" />
                          </Button>
                        )}
                        {permissions.scheduleStart && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Run startup now"
                            onClick={() => setRunSchedule({ id: s.id, mode: 'startup' })}
                          >
                            <AppIcon icon={CirclePlay} size="sm" />
                          </Button>
                        )}
                        {permissions.scheduleEdit && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setEditSchedule(s);
                                setDrawerOpen(true);
                              }}
                            >
                              <AppIcon icon={PenLine} size="sm" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => setScheduleToDelete(s)}>
                              <AppIcon icon={Trash2} size="sm" className="text-red-500" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      )}

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
