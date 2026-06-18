'use client';

import {
  type DashboardDatePreset,
  type DashboardDateRange,
} from '@/lib/dashboard-date-range';
import {
  DashboardFilterBar,
  DashboardFilterDateInput,
  DashboardFilterField,
  DashboardFilterSelect,
} from '@/components/dashboard/dashboard-filters';
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
    <DashboardFilterBar
      className={cn(
        'rounded-xl border border-border bg-card/60 px-4 py-2.5',
        className
      )}
    >
      <DashboardFilterField label="Period" htmlFor="dashboard-period">
        <DashboardFilterSelect
          id="dashboard-period"
          width="period"
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
        </DashboardFilterSelect>
      </DashboardFilterField>

      {value.preset === 'custom' ? (
        <>
          <DashboardFilterField label="From" htmlFor="dashboard-from">
            <DashboardFilterDateInput
              id="dashboard-from"
              value={value.customFrom}
              onChange={(e) => onChange({ ...value, customFrom: e.target.value })}
              aria-label="From date"
            />
          </DashboardFilterField>
          <DashboardFilterField label="To" htmlFor="dashboard-to">
            <DashboardFilterDateInput
              id="dashboard-to"
              value={value.customTo}
              onChange={(e) => onChange({ ...value, customTo: e.target.value })}
              aria-label="To date"
            />
          </DashboardFilterField>
        </>
      ) : null}
    </DashboardFilterBar>
  );
}
