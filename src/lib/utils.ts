import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export const IST_TIMEZONE = 'Asia/Kolkata';

/** YYYY-MM-DD for `<input type="date">` in IST (matches displayed timestamps). */
export function formatDateInputIST(date: Date = new Date()): string {
  return formatInTimeZone(date, IST_TIMEZONE, 'yyyy-MM-dd');
}

/** Start of calendar day in IST as UTC Date for API queries. */
export function parseDateInputStartIST(dateStr: string): Date {
  return fromZonedTime(`${dateStr}T00:00:00`, IST_TIMEZONE);
}

/** End of calendar day in IST as UTC Date for API queries. */
export function parseDateInputEndIST(dateStr: string): Date {
  return fromZonedTime(`${dateStr}T23:59:59.999`, IST_TIMEZONE);
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return 'Never';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

export function formatTimestampIST(date: string | Date | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return formatInTimeZone(d, IST_TIMEZONE, 'dd MMM yyyy, hh:mm:ss a') + ' IST';
  } catch {
    return '—';
  }
}

export function formatHoursDisplay(hours: number): string {
  if (hours <= 0) return '0h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

/** Stopped duration for dashboard tables: minutes below 1h, then hours, then days. */
export function formatStoppedDuration(ms: number): string {
  if (ms <= 0) return '0 min';

  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return '< 1 min';
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const totalHours = ms / 3_600_000;
  if (totalHours < 24) {
    const hours = Math.floor(totalHours);
    const minutes = Math.round((ms - hours * 3_600_000) / 60_000);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = Math.round(totalHours % 24);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  const fractionDigits = amount < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

/** Signed daily cost impact (increases positive, decreases negative). */
export function formatSignedUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return '$0.00';
  const fractionDigits = Math.abs(amount) < 0.01 ? 4 : 2;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Math.abs(amount));
  return amount > 0 ? `+${formatted}` : `-${formatted}`;
}

/** Sum savings without zeroing sub-cent amounts before display. */
export function sumUsd(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0);
}

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function daysOfWeekLabel(days: number[]): string {
  return days
    .sort((a, b) => a - b)
    .map((d) => DAY_LABELS[d - 1] ?? '?')
    .join(', ');
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];
const WHOLE_WEEK = [1, 2, 3, 4, 5, 6, 7];

function daysKey(days: number[]): string {
  return [...days].sort((a, b) => a - b).join(',');
}

export function daysOfWeekSummary(days: number[]): { label: string; tooltip: string } {
  const sorted = [...days].sort((a, b) => a - b);
  const tooltip = sorted.map((d) => DAY_LABELS[d - 1] ?? '?').join(', ');
  const key = daysKey(days);

  if (key === daysKey(WHOLE_WEEK)) return { label: 'Whole week', tooltip };
  if (key === daysKey(WEEKDAYS)) return { label: 'Weekdays', tooltip };
  if (key === daysKey(WEEKEND)) return { label: 'Weekend', tooltip };
  return { label: tooltip, tooltip };
}

const ENV_NAMESPACE_PATTERNS: [RegExp, string][] = [
  [/^prod(uction)?$/i, 'Production'],
  [/^dev(elop(ment)?)?$/i, 'Development'],
  [/^(stg|staging)$/i, 'Staging'],
  [/^uat$/i, 'UAT'],
  [/^qa|test(ing)?$/i, 'QA'],
  [/^dr|disaster[-_]?recovery$/i, 'DR'],
];

/** Best-effort environment label from namespace or cluster name prefix. */
export function inferScheduleEnvironment(namespace: string, cluster: string): string {
  const { clusterName } = parseClusterDisplay(cluster);
  for (const [pattern, label] of ENV_NAMESPACE_PATTERNS) {
    if (pattern.test(namespace)) return label;
  }
  const clusterMatch = clusterName.match(/^(prod|dev|stg|staging|uat|qa|dr|test)-/i);
  if (clusterMatch) return clusterMatch[1].toUpperCase();
  return namespace;
}

/** Parse EKS-style cluster names like `123456789012/my-cluster`. */
export function parseClusterDisplay(cluster: string | null | undefined): {
  accountId: string | null;
  clusterName: string;
} {
  if (cluster == null || typeof cluster !== 'string') {
    return { accountId: null, clusterName: '—' };
  }
  const normalized = cluster.trim();
  if (
    normalized === 'in-cluster' ||
    normalized === 'kubernetes.default.svc' ||
    normalized === 'https://kubernetes.default.svc'
  ) {
    return { accountId: null, clusterName: 'in-cluster' };
  }
  const slash = normalized.indexOf('/');
  if (slash > 0) {
    const accountId = normalized.slice(0, slash);
    const clusterName = normalized.slice(slash + 1);
    if (/^\d{10,14}$/.test(accountId)) {
      return { accountId, clusterName };
    }
  }
  return { accountId: null, clusterName: normalized };
}

/** Display 24h HH:mm as 12h with AM/PM. */
export function formatTime12h(time24: string): string {
  const [hourStr, minuteStr] = time24.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return time24;

  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

/** Startup is earlier in the day than shutdown — workloads stay down overnight. */
export function isOvernightSchedule(shutdownTime: string, startupTime: string): boolean {
  const [shH, shM] = shutdownTime.split(':').map(Number);
  const [stH, stM] = startupTime.split(':').map(Number);
  return stH * 60 + stM < shH * 60 + shM;
}

/** Full date + time for next scheduled execution. */
export function formatNextRunAt(
  iso: string | Date | null | undefined,
  timezone?: string
): string {
  if (!iso) return '—';
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** Human-readable countdown from milliseconds. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Starting now';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
