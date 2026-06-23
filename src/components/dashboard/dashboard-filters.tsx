'use client';

import { ChevronDown } from 'lucide-react';
import { DASHBOARD_FILTER_INPUT_CLASS } from '@/lib/dashboard-date-range';
import { cn } from '@/lib/utils';

export function DashboardFilterBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>{children}</div>
  );
}

/** Fixed-height control row below chart panel headers so sibling cards stay aligned. */
export function DashboardChartToolbar({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-10 shrink-0 items-center justify-end gap-3 overflow-x-auto border-b border-border/60 px-5',
        className
      )}
    >
      {children}
    </div>
  );
}

export function DashboardFilterField({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex items-center gap-2.5', className)}>
      <label
        htmlFor={htmlFor}
        className="shrink-0 text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const SELECT_WIDTH = {
  sm: 'w-[9.5rem]',
  md: 'w-[11.5rem]',
  lg: 'w-[16rem]',
  period: 'w-[9.75rem]',
} as const;

type SelectWidth = keyof typeof SELECT_WIDTH;

export function DashboardFilterSelect({
  width = 'md',
  className,
  title,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { width?: SelectWidth }) {
  return (
    <div className={cn('relative shrink-0', SELECT_WIDTH[width])}>
      <select
        title={title}
        className={cn(
          'h-8 w-full appearance-none rounded-lg border border-border bg-background',
          'pl-3 pr-8 text-[11px] leading-none text-foreground',
          'focus:outline-none focus:ring-2 focus:ring-blue-500/30',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        strokeWidth={2}
        aria-hidden
      />
    </div>
  );
}

export function DashboardFilterDateInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="date"
      className={cn(DASHBOARD_FILTER_INPUT_CLASS, 'w-[9.5rem] shrink-0', className)}
      {...props}
    />
  );
}

export function DashboardToggleGroup<T extends string>({
  value,
  onChange,
  options,
  capitalize = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { id: T; label: string }[];
  capitalize?: boolean;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center rounded-lg bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            'inline-flex h-7 items-center justify-center rounded-md px-3 text-[10px] transition-colors',
            capitalize && 'capitalize',
            value === option.id
              ? 'border border-border bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
