'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CirclePlay,
  CircleStop,
  ICON_STROKE,
  PenLine,
  Trash2,
  X,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import type { Schedule } from '@/lib/api-client';
import {
  DAY_LABELS,
  cn,
  formatNextRunAt,
  formatRelativeTime,
  formatTime12h,
  inferScheduleEnvironment,
  parseClusterDisplay,
} from '@/lib/utils';
import { isOnetimeSchedule, isWindowSchedule, isWindowOnce, isCombinedSchedule } from '@/lib/schedule-recurrence';
import { dayLabel } from '@/lib/schedule-window';
import {
  formatWorkloadKeyLabel,
  isNamespaceSchedule,
} from '@/lib/workload-utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ScheduleStatusCell,
  ScheduleShutdownAtCell,
  ScheduleStartupAtCell,
  ScheduleRepeatsCell,
} from '@/components/pod-scheduler/schedule-table-cells';

export interface ScheduleLiveInfo {
  message?: string;
  startupAt?: string | null;
}

interface ScheduleDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  schedule: Schedule | null;
  liveInfo?: ScheduleLiveInfo;
  canEdit?: boolean;
  canStart?: boolean;
  canStop?: boolean;
  onEdit?: (schedule: Schedule) => void;
  onRun?: (schedule: Schedule, mode: 'shutdown' | 'startup') => void;
  onDelete?: (schedule: Schedule) => void;
}

function recurrenceLabel(recurrence: Schedule['recurrence']): string {
  if (recurrence === 'split') return 'Weekday + Weekend';
  if (recurrence === 'onetime') return 'One-time';
  if (recurrence === 'window') return 'Stop day → Start day';
  if (recurrence === 'combined') return 'Long stop + nightly';
  return 'Daily';
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('text-right text-foreground', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

function SplitWindowBlock({
  title,
  days,
  shutdown,
  startup,
}: {
  title: string;
  days: number[];
  shutdown: string;
  startup: string;
}) {
  const dayNames =
    days.length > 0
      ? days
          .slice()
          .sort((a, b) => a - b)
          .map((d) => DAY_LABELS[d - 1] ?? '?')
          .join(', ')
      : 'No days selected';

  return (
    <div className="rounded-lg border border-border/80 bg-card/40 px-3 py-2.5">
      <p className="text-[11px] font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{dayNames}</p>
      <p className="mt-2 text-[11px] text-foreground">
        Shutdown {formatTime12h(shutdown)} · Startup {formatTime12h(startup)}
      </p>
    </div>
  );
}

function ScheduleDetailBody({
  schedule,
  liveInfo,
}: {
  schedule: Schedule;
  liveInfo?: ScheduleLiveInfo;
}) {
  const { clusterName, accountId } = parseClusterDisplay(schedule.cluster);
  const env = inferScheduleEnvironment(schedule.namespace, schedule.cluster);
  const weekdayDays = schedule.daysOfWeek.filter((d) => !schedule.weekendDays.includes(d));

  return (
    <div className="space-y-5">
      <DetailSection title="Overview">
        <DetailRow label="Status" value={<ScheduleStatusCell schedule={schedule} />} />
        {schedule.liveStopSource === 'manual' && (
          <DetailRow
            label="Stopped by"
            value={schedule.liveStoppedByName ?? schedule.liveStoppedBy ?? 'Unknown user'}
          />
        )}
        <DetailRow
          label="Platform"
          value={schedule.platformType === 'non_eks' ? 'Manual (Non-EKS / EC2)' : 'EKS'}
        />
        <DetailRow label="Cluster" value={clusterName} mono />
        <DetailRow label="Account ID" value={schedule.awsAccountId ?? accountId ?? '—'} mono />
        <DetailRow label="Environment" value={env} />
        <DetailRow label="Namespace" value={schedule.namespace} mono />
      </DetailSection>

      <DetailSection title="Target">
        <DetailRow
          label="Scope"
          value={isNamespaceSchedule(schedule) ? 'Entire namespace' : 'Single workload'}
        />
        {!isNamespaceSchedule(schedule) && (
          <>
            <DetailRow label="Workload" value={schedule.appName} mono />
            <DetailRow label="Kind" value={schedule.workloadKind || 'Deployment'} />
          </>
        )}
        {isNamespaceSchedule(schedule) && schedule.excludedWorkloads.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
            <p className="text-[11px] text-muted-foreground">Excluded workloads</p>
            <ul className="space-y-1">
              {schedule.excludedWorkloads.map((key) => (
                <li key={key} className="font-mono text-[11px] text-foreground">
                  {formatWorkloadKeyLabel(key)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {schedule.platformType === 'non_eks' && (
          <>
            <DetailRow label="EC2 instance" value={schedule.ec2InstanceId ?? '—'} mono />
            <DetailRow label="Region" value={schedule.ec2Region ?? '—'} />
          </>
        )}
      </DetailSection>

      <DetailSection title="Schedule">
        <DetailRow label="Type" value={recurrenceLabel(schedule.recurrence)} />
        <DetailRow label="Repeats" value={<ScheduleRepeatsCell schedule={schedule} />} />
        <DetailRow label="Timezone" value={schedule.timezone} mono />

        {schedule.recurrence === 'split' ? (
          <div className="mt-2 space-y-2">
            <SplitWindowBlock
              title="Weekday window"
              days={weekdayDays}
              shutdown={schedule.shutdownTime}
              startup={schedule.startupTime}
            />
            <SplitWindowBlock
              title="Weekend window"
              days={schedule.weekendDays}
              shutdown={schedule.weekendShutdownTime ?? schedule.shutdownTime}
              startup={schedule.weekendStartupTime ?? schedule.startupTime}
            />
          </div>
        ) : schedule.recurrence === 'window' ? (
          <>
            {schedule.windowRepeatWeekly === false ? (
              <>
                <DetailRow
                  label="Shutdown at"
                  value={<ScheduleShutdownAtCell schedule={schedule} />}
                />
                <DetailRow
                  label="Startup at"
                  value={<ScheduleStartupAtCell schedule={schedule} />}
                />
                <DetailRow label="Repeat" value="Once only" />
              </>
            ) : (
              <>
                <DetailRow
                  label="Stop"
                  value={`${dayLabel(schedule.shutdownDayOfWeek)} at ${formatTime12h(schedule.shutdownTime)}`}
                />
                <DetailRow
                  label="Start"
                  value={`${dayLabel(schedule.startupDayOfWeek)} at ${formatTime12h(schedule.startupTime)}`}
                />
                <DetailRow label="Repeat" value="Every week" />
              </>
            )}
          </>
        ) : schedule.recurrence === 'combined' ? (
          <>
            <DetailRow
              label="Long stop"
              value={`${dayLabel(schedule.shutdownDayOfWeek)} ${formatTime12h(schedule.shutdownTime)} → ${dayLabel(schedule.startupDayOfWeek)} ${formatTime12h(schedule.startupTime)}`}
            />
            <DetailRow
              label="Nightly stops"
              value={
                (schedule.overnightDays?.length ?? 0) > 0
                  ? `${schedule.overnightDays.map((d) => dayLabel(d)).join(', ')} · ${formatTime12h(schedule.overnightShutdownTime ?? '00:00')}–${formatTime12h(schedule.overnightStartupTime ?? '07:00')}`
                  : 'None'
              }
            />
            <DetailRow label="Repeat" value="Every week" />
          </>
        ) : schedule.recurrence === 'onetime' ? (
          <>
                <DetailRow
                  label="Shutdown at"
                  value={<ScheduleShutdownAtCell schedule={schedule} />}
                />
                <DetailRow
                  label="Startup at"
                  value={<ScheduleStartupAtCell schedule={schedule} />}
                />
            <DetailRow
              label="Completed"
              value={schedule.oneTimeCompleted ? 'Yes' : 'No'}
            />
          </>
        ) : (
          <>
            <DetailRow label="Shutdown" value={formatTime12h(schedule.shutdownTime)} />
            <DetailRow label="Startup" value={formatTime12h(schedule.startupTime)} />
          </>
        )}
      </DetailSection>

      {schedule.platformType === 'eks' && (
        <DetailSection title="Argo CD">
          <DetailRow
            label="Sync policy"
            value={schedule.syncPolicy === 'automated' ? 'Automated' : 'Manual (none)'}
          />
          <DetailRow
            label="Argo instance"
            value={schedule.argocdInstanceId ? 'Configured' : 'Auto-detect'}
          />
          <DetailRow label="Target replicas" value={String(schedule.targetReplicas)} />
        </DetailSection>
      )}

      <DetailSection title="Operations">
        <DetailRow label="Enabled" value={schedule.enabled ? 'Yes' : 'No'} />
        <DetailRow
          label="Last run"
          value={schedule.lastRun ? formatRelativeTime(schedule.lastRun) : 'Never'}
        />
        <DetailRow
          label="Next run"
          value={formatNextRunAt(schedule.nextRun, schedule.timezone)}
        />
        {schedule.liveActive && liveInfo?.startupAt && (
          <DetailRow
            label="Startup at"
            value={formatNextRunAt(liveInfo.startupAt, schedule.timezone)}
          />
        )}
        {liveInfo?.message && (
          <p className="mt-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {liveInfo.message}
          </p>
        )}
        <DetailRow
          label="Automatic Teams alert"
          value={schedule.teamsAlertEnabled ? 'Enabled' : 'Disabled'}
        />
        <DetailRow
          label="Manual Teams alert"
          value={schedule.teamsManualAlertEnabled ? 'Enabled' : 'Disabled'}
        />
        {schedule.savedReplicas != null && (
          <DetailRow label="Saved replicas" value={String(schedule.savedReplicas)} />
        )}
      </DetailSection>
    </div>
  );
}

export function ScheduleDetailDrawer({
  open,
  onClose,
  schedule,
  liveInfo,
  canEdit,
  canStart,
  canStop,
  onEdit,
  onRun,
  onDelete,
}: ScheduleDetailDrawerProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !mounted || !schedule) return null;

  const showActions = canEdit || canStart || canStop;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex justify-end">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cn(
          'relative z-10 flex h-dvh w-full max-w-lg flex-col border-l border-border bg-card shadow-2xl',
          'animate-in slide-in-from-right duration-300'
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-detail-title"
      >
        <div className="sticky top-0 z-20 shrink-0 border-b border-border bg-card px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Schedule details
              </p>
              <h2
                id="schedule-detail-title"
                className="mt-1 truncate text-base font-semibold text-foreground"
              >
                {schedule.name}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <ScheduleStatusCell schedule={schedule} />
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={ICON_STROKE} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
          <ScheduleDetailBody schedule={schedule} liveInfo={liveInfo} />
        </div>

        {showActions && (
          <div className="shrink-0 border-t border-border bg-card px-4 py-3">
            <div className="flex flex-wrap gap-2">
              {canStop && onRun && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-rose-600 hover:text-rose-600 dark:text-rose-400"
                  onClick={() => onRun(schedule, 'shutdown')}
                >
                  <AppIcon icon={CircleStop} size="sm" />
                  Run shutdown
                </Button>
              )}
              {canStart && onRun && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-emerald-600 hover:text-emerald-600 dark:text-emerald-400"
                  onClick={() => onRun(schedule, 'startup')}
                >
                  <AppIcon icon={CirclePlay} size="sm" />
                  Run startup
                </Button>
              )}
              {canEdit && onEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onEdit(schedule)}
                >
                  <AppIcon icon={PenLine} size="sm" />
                  Edit
                </Button>
              )}
              {canEdit && onDelete && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                  onClick={() => onDelete(schedule)}
                >
                  <AppIcon icon={Trash2} size="sm" />
                  Delete
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
