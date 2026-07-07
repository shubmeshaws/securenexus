export const AUTOMATION_SCHEDULE_FREQUENCIES = [
  { id: 'daily', label: 'Every day', description: 'Runs once per day at the scheduled time' },
  { id: 'weekly', label: 'Once a week', description: 'Runs on selected weekdays' },
  { id: 'monthly', label: 'Once a month', description: 'Runs on a specific day each month' },
  { id: 'quarterly', label: 'Every 3 months', description: 'Runs every quarter from the anchor date' },
  { id: 'semiannual', label: 'Every 6 months', description: 'Runs twice a year from the anchor date' },
  { id: 'yearly', label: 'Once a year', description: 'Runs on the same date every year' },
  { id: 'once', label: 'Once at specific date & time', description: 'Single run — no repeat' },
] as const;

export type AutomationScheduleFrequency = (typeof AUTOMATION_SCHEDULE_FREQUENCIES)[number]['id'];

export interface AutomationScheduleInput {
  scheduleFrequency: AutomationScheduleFrequency;
  scheduleTime: string;
  scheduleDays: number[];
  scheduleDayOfMonth: number | null;
  scheduleMonth: number | null;
  scheduleStartDate: string | null;
  timezone: string;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function normalizeScheduleFrequency(value: string | null | undefined): AutomationScheduleFrequency {
  const match = AUTOMATION_SCHEDULE_FREQUENCIES.find((row) => row.id === value);
  return match?.id ?? 'weekly';
}

export function validateAutomationSchedule(input: AutomationScheduleInput): string | null {
  if (!input.scheduleTime.trim()) return 'Schedule time is required.';

  if (input.scheduleFrequency === 'weekly' && input.scheduleDays.length === 0) {
    return 'Select at least one weekday for weekly schedules.';
  }

  if (
    (input.scheduleFrequency === 'monthly' ||
      input.scheduleFrequency === 'quarterly' ||
      input.scheduleFrequency === 'semiannual') &&
    !input.scheduleDayOfMonth
  ) {
    return 'Select the day of month for this schedule.';
  }

  if (input.scheduleFrequency === 'yearly') {
    if (!input.scheduleMonth) return 'Select the month for yearly schedules.';
    if (!input.scheduleDayOfMonth) return 'Select the day of month for yearly schedules.';
  }

  if (
    (input.scheduleFrequency === 'once' ||
      input.scheduleFrequency === 'quarterly' ||
      input.scheduleFrequency === 'semiannual') &&
    !input.scheduleStartDate?.trim()
  ) {
    return 'Start date is required for this schedule type.';
  }

  return null;
}

export function formatAutomationScheduleSummary(input: AutomationScheduleInput): string {
  const time = input.scheduleTime;
  const tz = input.timezone;

  switch (input.scheduleFrequency) {
    case 'daily':
      return `Daily at ${time} ${tz}`;
    case 'weekly': {
      const days =
        input.scheduleDays.length > 0
          ? input.scheduleDays.map((d) => WEEKDAY_SHORT[d] ?? String(d)).join(', ')
          : '—';
      return `Weekly on ${days} at ${time} ${tz}`;
    }
    case 'monthly':
      return `Monthly on day ${input.scheduleDayOfMonth ?? '—'} at ${time} ${tz}`;
    case 'quarterly':
      return `Every 3 months from ${input.scheduleStartDate ?? '—'} (day ${input.scheduleDayOfMonth ?? '—'}) at ${time} ${tz}`;
    case 'semiannual':
      return `Every 6 months from ${input.scheduleStartDate ?? '—'} (day ${input.scheduleDayOfMonth ?? '—'}) at ${time} ${tz}`;
    case 'yearly':
      return `Yearly on ${input.scheduleMonth ?? '—'}/${input.scheduleDayOfMonth ?? '—'} at ${time} ${tz}`;
    case 'once':
      return `Once on ${input.scheduleStartDate ?? '—'} at ${time} ${tz}`;
    default:
      return `${time} ${tz}`;
  }
}
