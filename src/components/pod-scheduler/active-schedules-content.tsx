'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Activity, CircleStop, Icons, Loader2 } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/utils';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
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
  recurrence: 'daily' | 'onetime';
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

export function ActiveSchedulesContent() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const [scheduleToStop, setScheduleToStop] = useState<LiveScheduleItem | null>(null);

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['schedules-live'],
    queryFn: () => apiFetch<LiveSchedulesResponse>('/api/schedules/live'),
    refetchInterval: POLL_INTERVAL,
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
          <p className="text-lg font-semibold text-foreground">{total}</p>
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
                  <th className="px-5 py-3 text-left font-medium">Timezone</th>
                  <th className="px-5 py-3 text-left font-medium">Days</th>
                  <th className="px-5 py-3 text-left font-medium">Time remaining</th>
                  <th className="px-5 py-3 text-left font-medium">Startup at</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
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
                          oneTimeShutdownAt: schedule.oneTimeShutdownAt,
                          timezone: schedule.timezone,
                        }}
                      />
                      {' → '}
                      <ScheduleStartupAtCell
                        schedule={{
                          recurrence: schedule.recurrence,
                          startupTime: schedule.startupTime,
                          oneTimeStartupAt: schedule.oneTimeStartupAt,
                          timezone: schedule.timezone,
                        }}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{schedule.timezone}</td>
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
