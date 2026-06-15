'use client';

import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  daysOfWeekSummary,
  formatTime12h,
  formatNextRunAt,
  inferScheduleEnvironment,
  parseClusterDisplay,
} from '@/lib/utils';
import {
  formatWorkloadKeyLabel,
  isNamespaceSchedule,
} from '@/lib/workload-utils';
import type { Schedule } from '@/lib/api-client';

export function ScheduleClusterCell({ cluster }: { cluster: string }) {
  const { clusterName } = parseClusterDisplay(cluster);
  return <span className="font-mono text-xs text-foreground">{clusterName}</span>;
}

export function ScheduleAccountIdCell({
  cluster,
  awsAccountId,
}: {
  cluster: string;
  awsAccountId?: string | null;
}) {
  const accountId = awsAccountId ?? parseClusterDisplay(cluster).accountId;
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {accountId ?? '—'}
    </span>
  );
}

export function ScheduleEnvironmentCell({
  cluster,
  namespace,
}: {
  cluster: string;
  namespace: string;
}) {
  const env = inferScheduleEnvironment(namespace, cluster);
  return <span className="text-xs text-foreground">{env}</span>;
}

export function ScheduleKindBadge({ kind }: { kind: string }) {
  return (
    <Badge variant="secondary" className="font-mono text-[10px]">
      {kind}
    </Badge>
  );
}

function TargetTooltip({
  label,
  details,
}: {
  label: string;
  details: string[];
}) {
  if (details.length === 0) {
    return <span className="text-xs text-foreground">{label}</span>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default border-b border-dashed border-muted-foreground/40 text-xs text-foreground">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs space-y-1">
          {details.map((line) => (
            <p key={line} className="font-mono text-[11px]">
              {line}
            </p>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ScheduleTargetCell({
  schedule,
}: {
  schedule: Pick<Schedule, 'scope' | 'appName' | 'workloadKind' | 'excludedWorkloads'>;
}) {
  if (isNamespaceSchedule(schedule)) {
    const excluded = schedule.excludedWorkloads?.length ?? 0;
    const label =
      excluded > 0 ? `All workloads (${excluded} excluded)` : 'All workloads';
    const details = (schedule.excludedWorkloads ?? []).map(formatWorkloadKeyLabel);

    return <TargetTooltip label={label} details={details} />;
  }

  const details = [`${schedule.appName} (${schedule.workloadKind ?? 'Deployment'})`];
  return <TargetTooltip label="Workloads" details={details} />;
}

export function ScheduleTimeCell({ time }: { time: string }) {
  return <span className="whitespace-nowrap text-xs text-foreground">{formatTime12h(time)}</span>;
}

export function ScheduleShutdownAtCell({
  schedule,
}: {
  schedule: Pick<
    Schedule,
    'recurrence' | 'shutdownTime' | 'oneTimeShutdownAt' | 'timezone'
  >;
}) {
  if (schedule.recurrence === 'onetime' && schedule.oneTimeShutdownAt) {
    return (
      <span className="whitespace-nowrap text-xs text-foreground">
        {formatNextRunAt(schedule.oneTimeShutdownAt, schedule.timezone)}
      </span>
    );
  }
  return <ScheduleTimeCell time={schedule.shutdownTime} />;
}

export function ScheduleStartupAtCell({
  schedule,
}: {
  schedule: Pick<
    Schedule,
    'recurrence' | 'startupTime' | 'oneTimeStartupAt' | 'timezone'
  >;
}) {
  if (schedule.recurrence === 'onetime' && schedule.oneTimeStartupAt) {
    return (
      <span className="whitespace-nowrap text-xs text-foreground">
        {formatNextRunAt(schedule.oneTimeStartupAt, schedule.timezone)}
      </span>
    );
  }
  return <ScheduleTimeCell time={schedule.startupTime} />;
}

export function ScheduleRepeatsCell({
  schedule,
}: {
  schedule: Pick<Schedule, 'recurrence' | 'daysOfWeek' | 'oneTimeCompleted' | 'enabled'>;
}) {
  if (schedule.recurrence === 'onetime') {
    const label = schedule.oneTimeCompleted ? 'One-time (done)' : 'One-time';
    return <span className="text-xs text-muted-foreground">{label}</span>;
  }
  return <ScheduleDaysCell days={schedule.daysOfWeek} />;
}

export function ScheduleDaysCell({ days }: { days: number[] }) {
  const { label, tooltip } = daysOfWeekSummary(days);
  const showTooltip = label !== tooltip;

  if (!showTooltip) {
    return <span className="text-xs text-muted-foreground">{label}</span>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default border-b border-dashed border-muted-foreground/40 text-xs text-muted-foreground">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-[11px]">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ScheduleNextRunCell({ schedule }: { schedule: Pick<Schedule, 'nextRun' | 'timezone'> }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-blue-600 dark:text-blue-400">
        {formatNextRunAt(schedule.nextRun, schedule.timezone)}
      </p>
    </div>
  );
}

export function ScheduleStatusCell({
  schedule,
}: {
  schedule: Pick<Schedule, 'enabled' | 'liveActive' | 'oneTimeCompleted'>;
}) {
  if (schedule.liveActive) {
    return (
      <Badge variant="failed" className="rounded-full text-[10px] font-semibold">
        Stopped
      </Badge>
    );
  }
  if (schedule.oneTimeCompleted) {
    return (
      <Badge variant="unknown" className="rounded-full text-[10px] font-medium">
        Completed
      </Badge>
    );
  }
  if (schedule.enabled) {
    return (
      <Badge variant="success" className="rounded-full text-[10px] font-medium">
        Enabled
      </Badge>
    );
  }
  return (
    <Badge variant="unknown" className="rounded-full text-[10px] font-medium">
      Disabled
    </Badge>
  );
}
