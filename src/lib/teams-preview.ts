import type { TeamsAlertPayload } from '@/lib/teams-webhook';
import { AUTOMATIC_CRON_TRIGGER } from '@/lib/alert-display';

export const TEAMS_ACTION_META: Record<
  string,
  { emoji: string; label: string; accentClass: string; headerBg: string }
> = {
  'schedule-run': { emoji: '⚡', label: 'Schedule Executed', accentClass: 'text-blue-600', headerBg: 'bg-blue-500/10' },
  'schedule-shutdown': { emoji: '🌙', label: 'Scheduled Shutdown', accentClass: 'text-orange-600', headerBg: 'bg-orange-500/10' },
  'schedule-startup': { emoji: '☀️', label: 'Scheduled Startup', accentClass: 'text-emerald-600', headerBg: 'bg-emerald-500/10' },
  'scale-down': { emoji: '⏬', label: 'Scale Down', accentClass: 'text-red-600', headerBg: 'bg-red-500/10' },
  'scale-up': { emoji: '⏫', label: 'Scale Up', accentClass: 'text-emerald-600', headerBg: 'bg-emerald-500/10' },
  'sync-off': { emoji: '🔕', label: 'Sync Disabled', accentClass: 'text-amber-600', headerBg: 'bg-amber-500/10' },
  'sync-on': { emoji: '🔔', label: 'Sync Enabled', accentClass: 'text-emerald-600', headerBg: 'bg-emerald-500/10' },
  'infra-shutdown': { emoji: '🛑', label: 'Infrastructure Stopped', accentClass: 'text-orange-600', headerBg: 'bg-orange-500/10' },
  'infra-startup': { emoji: '🚀', label: 'Infrastructure Started', accentClass: 'text-emerald-600', headerBg: 'bg-emerald-500/10' },
  'alert-broadcast': { emoji: '📢', label: 'Team Announcement', accentClass: 'text-violet-600', headerBg: 'bg-violet-500/10' },
  'security-scan': { emoji: '🛡️', label: 'Security Scan Report', accentClass: 'text-violet-600', headerBg: 'bg-violet-500/10' },
};

export function getTeamsPreviewMeta(action: string, title?: string) {
  return (
    TEAMS_ACTION_META[action] ?? {
      emoji: '🔔',
      label: title ?? 'SecureNexus Alert',
      accentClass: 'text-blue-600',
      headerBg: 'bg-blue-500/10',
    }
  );
}

export function sampleTeamsPreviewPayload(): TeamsAlertPayload {
  return {
    title: 'Scheduled Shutdown',
    message: 'Scaled 6 workload(s) to 0 in sms',
    action: 'schedule-shutdown',
    cluster: '789382029892/dr-eks-cluster',
    namespace: 'sms',
    appName: '*',
    triggeredBy: AUTOMATIC_CRON_TRIGGER,
    status: 'success',
    startTime: 'Sat, Jun 14, 2026, 4:45 PM',
  };
}
