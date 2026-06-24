'use client';

import { cn } from '@/lib/utils';

export type DashboardTab = 'overview' | 'node-changes' | 'pod-changes' | 'activity-tracker';

export function DashboardTabs({
  active,
  onChange,
}: {
  active: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}) {
  const tabs: { id: DashboardTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'node-changes', label: 'Node changes' },
    { id: 'pod-changes', label: 'Pod changes' },
    { id: 'activity-tracker', label: 'Activity tracker' },
  ];

  return (
    <nav
      aria-label="Dashboard sections"
      className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-card/60 p-1"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors',
            active === tab.id
              ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
