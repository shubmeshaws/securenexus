import type { ActivityAction } from '@/lib/activity';
import { NAMESPACE_SCOPE_MARKER } from '@/lib/workload-utils';

export const AUTOMATIC_CRON_TRIGGER = 'automatic-cron';

export function formatAlertTarget(appName: string): string {
  if (!appName?.trim() || appName === NAMESPACE_SCOPE_MARKER || appName === '*') {
    return 'Whole namespace';
  }
  return appName;
}

export function formatAlertTriggeredBy(
  triggeredBy: string,
  options?: {
    userName?: string;
    action?: ActivityAction | string;
  }
): string {
  const { userName, action } = options ?? {};

  if (triggeredBy === AUTOMATIC_CRON_TRIGGER || triggeredBy === 'scheduler') {
    return 'Automatic cron';
  }

  if (userName?.trim()) {
    return userName.trim();
  }

  if (triggeredBy.includes('@')) {
    return triggeredBy.split('@')[0];
  }

  if (triggeredBy === 'manual' || triggeredBy === 'bulk-action' || triggeredBy === 'infra-control') {
    return 'Manual action';
  }

  if (
    (action === 'schedule-shutdown' || action === 'schedule-startup') &&
    !triggeredBy.includes('@')
  ) {
    return 'Automatic cron';
  }

  return triggeredBy;
}

const AUTOMATIC_ACTIONS = new Set([
  'schedule-shutdown',
  'schedule-startup',
  'schedule-run',
]);

export function isAutomaticActivityTrigger(
  triggeredBy: string,
  action?: ActivityAction | string
): boolean {
  if (triggeredBy === AUTOMATIC_CRON_TRIGGER || triggeredBy === 'scheduler') {
    return true;
  }
  if (
    action &&
    AUTOMATIC_ACTIONS.has(action) &&
    !triggeredBy.includes('@') &&
    triggeredBy !== 'manual' &&
    triggeredBy !== 'bulk-action' &&
    triggeredBy !== 'infra-control'
  ) {
    return true;
  }
  return false;
}

/** User column for activity logs: Automatic for cron/scheduler, otherwise display name. */
export function activityActorLabel(
  triggeredBy: string,
  options?: {
    userName?: string | null;
    action?: ActivityAction | string;
  }
): string {
  const { userName, action } = options ?? {};

  if (isAutomaticActivityTrigger(triggeredBy, action)) {
    return 'Automatic';
  }

  if (userName?.trim()) {
    return userName.trim();
  }

  return formatAlertTriggeredBy(triggeredBy, { userName: userName ?? undefined, action });
}
