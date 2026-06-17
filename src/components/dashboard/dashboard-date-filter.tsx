'use client';

import {
  DASHBOARD_DATE_SELECT_CLASS,
  type DashboardDatePreset,
  type DashboardDateRange,
  getDashboardPeriodLabel,
} from '@/lib/dashboard-date-range';
import { cn } from '@/lib/utils';

export default function DashboardDateFilter({
  value,
  onChange,
  className,
}: {
  value: DashboardDateRange;
  onChange: (next: DashboardDateRange) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2.5',
        className
      )}
    >
      <span className="text-[11px] font-medium text-muted-foreground">Period</span>
      <select
        className={cn(DASHBOARD_DATE_SELECT_CLASS, 'w-auto max-w-[8.5rem]')}
        value={value.preset}
        onChange={(e) =>
          onChange({
            ...value,
            preset: e.target.value as DashboardDatePreset,
          })
        }
        aria-label="Dashboard date range"
      >
        <option value="7">Last 7 days</option>
        <option value="14">Last 14 days</option>
        <option value="30">Last 30 days</option>
        <option value="custom">Custom range</option>
      </select>

      {value.preset === 'custom' ? (
        <>
          <input
            type="date"
            className={cn(DASHBOARD_DATE_SELECT_CLASS, 'w-auto')}
            value={value.customFrom}
            onChange={(e) => onChange({ ...value, customFrom: e.target.value })}
            aria-label="From date"
          />
          <span className="text-[11px] text-muted-foreground">to</span>
          <input
            type="date"
            className={cn(DASHBOARD_DATE_SELECT_CLASS, 'w-auto')}
            value={value.customTo}
            onChange={(e) => onChange({ ...value, customTo: e.target.value })}
            aria-label="To date"
          />
        </>
      ) : (
        <span className="text-[11px] text-muted-foreground">{getDashboardPeriodLabel(value)}</span>
      )}
    </div>
  );
}
