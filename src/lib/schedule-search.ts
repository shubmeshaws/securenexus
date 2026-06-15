import type { Schedule } from '@/lib/api-client';
import {
  daysOfWeekSummary,
  formatNextRunAt,
  formatTime12h,
  inferScheduleEnvironment,
  parseClusterDisplay,
} from '@/lib/utils';
import { formatWorkloadKeyLabel, isNamespaceSchedule } from '@/lib/workload-utils';

function scheduleTargetLabel(schedule: Schedule): string {
  if (isNamespaceSchedule(schedule)) {
    const excluded = schedule.excludedWorkloads?.length ?? 0;
    return excluded > 0 ? `All workloads (${excluded} excluded)` : 'All workloads';
  }
  if (schedule.platformType === 'non_eks') {
    return `${schedule.appName} EC2 manual`;
  }
  return `${schedule.appName} ${schedule.workloadKind ?? 'Deployment'}`;
}

function scheduleStatusLabel(schedule: Schedule): string {
  if (schedule.liveActive) return 'Stopped live';
  if (schedule.oneTimeCompleted) return 'Completed one-time';
  return schedule.enabled ? 'Enabled' : 'Disabled';
}

function scheduleRepeatsLabel(schedule: Schedule): string {
  if (schedule.recurrence === 'onetime') {
    return schedule.oneTimeCompleted ? 'One-time (done)' : 'One-time';
  }
  return daysOfWeekSummary(schedule.daysOfWeek).label;
}

function scheduleShutdownLabel(schedule: Schedule): string {
  if (schedule.recurrence === 'onetime' && schedule.oneTimeShutdownAt) {
    return formatNextRunAt(schedule.oneTimeShutdownAt, schedule.timezone);
  }
  return formatTime12h(schedule.shutdownTime);
}

function scheduleStartupLabel(schedule: Schedule): string {
  if (schedule.recurrence === 'onetime' && schedule.oneTimeStartupAt) {
    return formatNextRunAt(schedule.oneTimeStartupAt, schedule.timezone);
  }
  return formatTime12h(schedule.startupTime);
}

/** Lowercase blob of all schedule fields shown in the table (for client-side search). */
export function scheduleSearchText(schedule: Schedule): string {
  const { clusterName, accountId: clusterAccountId } = parseClusterDisplay(schedule.cluster);
  const environment = inferScheduleEnvironment(schedule.namespace, schedule.cluster);
  const platform =
    schedule.platformType === 'non_eks' ? 'non eks manual ec2' : 'eks kubernetes';

  return [
    schedule.name,
    clusterName,
    schedule.cluster,
    schedule.awsAccountId,
    clusterAccountId,
    environment,
    schedule.namespace,
    scheduleTargetLabel(schedule),
    ...(schedule.excludedWorkloads ?? []).map(formatWorkloadKeyLabel),
    scheduleShutdownLabel(schedule),
    scheduleStartupLabel(schedule),
    schedule.shutdownTime,
    schedule.startupTime,
    schedule.timezone,
    scheduleRepeatsLabel(schedule),
    scheduleStatusLabel(schedule),
    formatNextRunAt(schedule.nextRun, schedule.timezone),
    platform,
    schedule.appName,
    schedule.workloadKind,
    schedule.ec2InstanceId,
    schedule.ec2Region,
  ]
    .filter((part) => part != null && String(part).trim())
    .join(' ')
    .toLowerCase();
}

export function filterSchedulesByQuery(schedules: Schedule[], query: string): Schedule[] {
  const q = query.trim().toLowerCase();
  if (!q) return schedules;
  return schedules.filter((schedule) => scheduleSearchText(schedule).includes(q));
}
