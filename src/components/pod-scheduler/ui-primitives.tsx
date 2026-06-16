'use client';

import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { getPageMeta } from '@/lib/page-meta';
import { ModernIcon, type IconAccent } from '@/components/ui/modern-icon';
import { BrandIcon } from '@/components/ui/brand-icon';
import type { LucideIcon } from 'lucide-react';

const STAT_GLOW: Record<IconAccent, string> = {
  blue: 'stat-aurora-blue',
  emerald: 'stat-aurora-emerald',
  amber: 'stat-aurora-amber',
  red: 'stat-aurora-red',
  sky: 'stat-aurora-sky',
  violet: 'stat-aurora-violet',
  slate: 'stat-aurora-violet',
};

export function PageHeader({
  title,
  description,
  action,
  icon: IconOverride,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
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
          <h1 className="page-title mt-1">{displayTitle}</h1>
          {description && (
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground sm:text-sm">
              {description}
            </p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0 self-start lg:self-center">{action}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon: Icon,
  accent = 'blue',
  trend,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  accent?: IconAccent;
  trend?: string;
}) {
  return (
    <div className={cn('stat-card group', STAT_GLOW[accent])}>
      <div className="mb-4 flex items-start justify-between">
        <ModernIcon icon={Icon} accent={accent} size="md" />
        {trend && (
          <span className="live-pill">{trend}</span>
        )}
      </div>
      <p className="stat-value">{value}</p>
      <p className="stat-label">{label}</p>
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
  action,
  accent = 'blue',
}: {
  title: string;
  icon?: LucideIcon;
  brandIconSrc?: string;
  brandIconAlt?: string;
  brandIconSurface?: 'default' | 'light';
  action?: React.ReactNode;
  accent?: IconAccent;
}) {
  return (
    <div className="modern-card-header">
      <div className="flex items-center gap-3">
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
      </div>
      {action}
    </div>
  );
}

/** Scrollable table body — shows ~maxRows then scrolls. */
export function ScrollTable({
  maxRows = 5,
  children,
  footer,
}: {
  maxRows?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const maxHeight = maxRows * 44 + 40;

  return (
    <div>
      <div
        className="overflow-x-auto overflow-y-auto scrollbar-thin"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {children}
      </div>
      {footer}
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
