'use client';

import type { LucideIcon } from 'lucide-react';
import { Loader2 } from '@/lib/icons';
import { cn } from '@/lib/utils';

const TONE_STYLES = {
  violet: 'border-violet-500/25 bg-violet-500/5 text-violet-600 hover:border-violet-500/45 hover:bg-violet-500/10',
  sky: 'border-sky-500/25 bg-sky-500/5 text-sky-600 hover:border-sky-500/45 hover:bg-sky-500/10',
  emerald: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-600 hover:border-emerald-500/45 hover:bg-emerald-500/10',
  slate: 'border-border/70 bg-background/80 text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground',
  danger: 'border-red-500/20 bg-red-500/5 text-red-600 hover:border-red-500/40 hover:bg-red-500/10',
} as const;

export function SecurityIconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  loading = false,
  tone = 'slate',
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: keyof typeof TONE_STYLES;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg border shadow-sm transition-all',
        'disabled:cursor-not-allowed disabled:opacity-45',
        TONE_STYLES[tone],
        className
      )}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      )}
    </button>
  );
}
