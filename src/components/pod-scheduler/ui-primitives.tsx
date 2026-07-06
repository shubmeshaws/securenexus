'use client';

import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { getPageMeta } from '@/lib/page-meta';
import { PageRefreshButton } from '@/components/pod-scheduler/page-refresh-button';
import { ModernIcon, type IconAccent } from '@/components/ui/modern-icon';
import { BrandIcon } from '@/components/ui/brand-icon';
import type { LucideIcon } from 'lucide-react';

export function PageHeader({
  title,
  description,
  titleMeta,
  action,
  icon: IconOverride,
  hideRefresh = false,
}: {
  title?: string;
  description?: string;
  titleMeta?: React.ReactNode;
  action?: React.ReactNode;
  icon?: LucideIcon;
  hideRefresh?: boolean;
}) {
  const pathname = usePathname();
  const meta = getPageMeta(pathname);
  const Icon = IconOverride ?? meta.icon;
  const displayTitle = title ?? meta.title;

  return (
    <div className="page-hero mb-2 flex w-full max-w-full flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <ModernIcon icon={Icon} accent={meta.accent} size="lg" />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {meta.subtitle}
          </p>
          <h1 className="page-title mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span>{displayTitle}</span>
            {titleMeta ? (
              <span className="text-xs font-normal text-muted-foreground sm:text-sm">{titleMeta}</span>
            ) : null}
          </h1>
          {description && (
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground sm:text-sm">
              {description}
            </p>
          )}
        </div>
      </div>
      {(action || !hideRefresh) && (
        <div className="flex shrink-0 items-center gap-2 self-start lg:self-center">
          {!hideRefresh ? <PageRefreshButton /> : null}
          {action}
        </div>
      )}
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon: Icon,
  accent = 'blue',
  trend,
  compact = false,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  accent?: IconAccent;
  trend?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('stat-card', compact && 'stat-card-compact')}>
      <div className={cn('flex items-start justify-between', compact ? 'mb-2' : 'mb-4')}>
        <ModernIcon icon={Icon} accent={accent} size={compact ? 'sm' : 'md'} />
        {trend && (
          <span className="live-pill">{trend}</span>
        )}
      </div>
      <p className={cn('stat-value', compact && 'stat-value-compact')}>{value}</p>
      <p className="stat-label">{label}</p>
    </div>
  );
}

/** Lightweight analytics-style metric card (no animations). */
export function InsightMetricCard({
  label,
  value,
  icon: Icon,
  accent = 'blue',
  hint,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  accent?: IconAccent;
  hint?: string;
}) {
  const iconBg: Record<IconAccent, string> = {
    blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    red: 'bg-red-500/10 text-red-600 dark:text-red-400',
    sky: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    slate: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
  };

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <div
        className={cn(
          'mb-4 flex h-10 w-10 items-center justify-center rounded-full',
          iconBg[accent]
        )}
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <p className="text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{label}</p>
      {hint && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function GlassPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('modern-card overflow-hidden', className)}>{children}</div>;
}

export function PanelHeader({
  title,
  icon: Icon,
  brandIconSrc,
  brandIconAlt,
  brandIconSurface,
  titleAddon,
  action,
  accent = 'blue',
}: {
  title: string;
  icon?: LucideIcon;
  brandIconSrc?: string;
  brandIconAlt?: string;
  brandIconSurface?: 'default' | 'light';
  /** Inline controls placed after the title on the same row (e.g. cluster filter). */
  titleAddon?: React.ReactNode;
  action?: React.ReactNode;
  accent?: IconAccent;
}) {
  return (
    <div className="modern-card-header">
      <div className="flex min-w-0 shrink flex-wrap items-center gap-x-3 gap-y-2">
        {brandIconSrc ? (
          <BrandIcon
            src={brandIconSrc}
            alt={brandIconAlt ?? title}
            accent={accent}
            size="sm"
            surface={brandIconSurface}
          />
        ) : (
          Icon && <ModernIcon icon={Icon} accent={accent} size="sm" />
        )}
        <h2 className="modern-card-title">{title}</h2>
        {titleAddon ? <div className="flex min-w-0 items-center">{titleAddon}</div> : null}
      </div>
      {action ? <div className="ml-auto flex shrink-0 items-center">{action}</div> : null}
    </div>
  );
}

/** Subtitle row aligned with PanelHeader title text (past the icon column). */
export function PanelSubtitle({
  children,
  action,
  alignWithIcon = true,
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  /** When false, text aligns with card padding (use when PanelHeader has no icon). */
  alignWithIcon?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5 pb-3',
        className
      )}
    >
      <div className={cn('flex min-w-0 flex-1 items-center gap-3', !alignWithIcon && 'gap-0')}>
        {alignWithIcon ? <div className="h-7 w-7 shrink-0" aria-hidden="true" /> : null}
        <p className="min-w-0 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">{children}</p>
      </div>
      {action ? <div className="ml-auto flex shrink-0 items-center">{action}</div> : null}
    </div>
  );
}

/** Scrollable table body — flexes within the panel so footers align across sibling cards. */
export function scrollTableBodyHeight(maxRows = 5): number {
  return maxRows * 44 + 40;
}

export function ScrollTable({
  maxRows = 5,
  children,
  footer,
  className,
}: {
  maxRows?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const bodyHeight = scrollTableBodyHeight(maxRows);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-thin"
        style={{ maxHeight: `${bodyHeight}px` }}
      >
        {children}
      </div>
      {footer ? <div className="mt-auto shrink-0">{footer}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <ModernIcon icon={Icon} accent="blue" size="lg" glow className="mb-4" />
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="inline-flex gap-1 rounded-2xl border border-border/60 bg-card p-1 shadow-sm">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn(
            'rounded-xl px-4 py-2 text-xs font-medium transition-all duration-200',
            active === tab.id
              ? 'bg-foreground text-background shadow-sm'
              : 'text-zinc-600 hover:bg-muted/60 hover:text-foreground dark:text-muted-foreground'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function UserAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'h-6 w-6 text-[9px]', md: 'h-8 w-8 text-xs', lg: 'h-10 w-10 text-sm' };
  const gradients = [
    'from-blue-500 to-sky-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-sky-500 to-blue-600',
    'from-rose-500 to-pink-600',
  ];
  const safeName = name?.trim() || '?';
  const idx = safeName.charCodeAt(0) % gradients.length;

  return (
    <div className={cn(
      'flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br font-bold text-white shadow-md',
      sizes[size],
      gradients[idx]
    )}>
      {safeName.charAt(0).toUpperCase()}
    </div>
  );
}
