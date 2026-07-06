'use client';

import type { LucideIcon } from 'lucide-react';
import { Download, Eye, FileText, Table2, Trash2 } from '@/lib/icons';
import { SecurityIconButton } from '@/components/pod-scheduler/security-icon-button';
import { cn } from '@/lib/utils';

const ACTION_TONES = {
  violet: 'border-violet-500/25 bg-violet-500/5 text-violet-600 hover:border-violet-500/45 hover:bg-violet-500/10',
  sky: 'border-sky-500/25 bg-sky-500/5 text-sky-600 hover:border-sky-500/45 hover:bg-sky-500/10',
  emerald: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-600 hover:border-emerald-500/45 hover:bg-emerald-500/10',
  slate: 'border-border/70 bg-background/80 text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground',
} as const;

function ReportActionButton({
  icon: Icon,
  label,
  href,
  onClick,
  tone = 'slate',
}: {
  icon: LucideIcon;
  label: string;
  href?: string;
  onClick?: () => void;
  tone?: keyof typeof ACTION_TONES;
}) {
  const className = cn(
    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium shadow-sm transition-all',
    ACTION_TONES[tone]
  );

  if (href) {
    return (
      <a href={href} className={className} title={label} aria-label={label}>
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span>{label}</span>
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className} title={label} aria-label={label}>
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      <span>{label}</span>
    </button>
  );
}

export function SecurityReportActions({
  reportId,
  onPreview,
  onDelete,
  deleting = false,
}: {
  reportId: string;
  onPreview: () => void;
  onDelete: () => void;
  deleting?: boolean;
}) {
  const base = `/api/security/reports/${reportId}/download`;

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <ReportActionButton icon={Eye} label="Preview" onClick={onPreview} tone="violet" />
      <ReportActionButton icon={Download} label="Download" href={`${base}?format=html`} tone="sky" />
      <ReportActionButton icon={Table2} label="CSV" href={`${base}?format=csv`} tone="emerald" />
      <ReportActionButton icon={FileText} label="PDF" href={`${base}?format=pdf`} tone="slate" />
      <SecurityIconButton
        icon={Trash2}
        label="Delete report"
        tone="danger"
        disabled={deleting}
        onClick={onDelete}
      />
    </div>
  );
}
