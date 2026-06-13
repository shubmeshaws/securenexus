'use client';

import { BadgeCheck, CircleAlert, Info, TriangleAlert } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { getTeamsPreviewMeta, sampleTeamsPreviewPayload } from '@/lib/teams-preview';
import { formatAlertTarget, formatAlertTriggeredBy } from '@/lib/alert-display';
import { parseClusterDisplay } from '@/lib/utils';
import type { TeamsAlertPayload } from '@/lib/teams-webhook';
import { cn } from '@/lib/utils';

const STATUS_STYLE = {
  success: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-red-600 dark:text-red-400',
};

export function TeamsCardPreview({ payload }: { payload?: TeamsAlertPayload }) {
  const data = payload ?? sampleTeamsPreviewPayload();
  const meta = getTeamsPreviewMeta(data.action, data.title);
  const { clusterName } = parseClusterDisplay(data.cluster);
  const statusLabel = data.status === 'success' ? 'Success' : 'Failed';
  const target = formatAlertTarget(data.appName);
  const actor = formatAlertTriggeredBy(data.triggeredBy, {
    userName: data.userName,
    action: data.action,
  });

  return (
    <div className="overflow-hidden rounded-xl border border-border shadow-sm">
      <div className={cn('border-b border-border/60 px-4 py-3', meta.headerBg)}>
        <div className="flex items-center gap-3">
          <span className="text-2xl leading-none">{meta.emoji}</span>
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-bold', meta.accentClass)}>{meta.label}</p>
            <p className="text-[10px] text-muted-foreground">SecureNexus Alert · style: emphasis</p>
          </div>
          <span className="text-lg">{data.status === 'success' ? '✅' : '❌'}</span>
        </div>
      </div>
      <div className="space-y-3 bg-card p-4">
        <p className="text-sm text-foreground leading-relaxed">{data.message}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <PreviewFact label="Status" value={statusLabel} valueClass={STATUS_STYLE[data.status]} />
          <PreviewFact label="Cluster" value={clusterName} mono />
          <PreviewFact label="Namespace" value={data.namespace} mono />
          <PreviewFact label="Target" value={target} mono />
          <PreviewFact label="Triggered by" value={actor} className="col-span-2" />
        </dl>
        <p className={cn('text-xs font-bold', STATUS_STYLE[data.status])}>
          {data.status === 'success' ? '✅' : '❌'} {statusLabel}
        </p>
      </div>
    </div>
  );
}

function PreviewFact({
  label,
  value,
  mono,
  valueClass,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClass?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 font-medium text-foreground', mono && 'font-mono text-[11px]', valueClass)}>
        {value}
      </dd>
    </div>
  );
}

export const IN_APP_ALERT_TYPES = [
  { id: 'info' as const, label: 'Info', icon: Info, style: 'text-blue-600 bg-blue-500/10 border-blue-500/20' },
  { id: 'success' as const, label: 'Success', icon: BadgeCheck, style: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20' },
  { id: 'warning' as const, label: 'Warning', icon: TriangleAlert, style: 'text-amber-600 bg-amber-500/10 border-amber-500/20' },
  { id: 'error' as const, label: 'Error', icon: CircleAlert, style: 'text-red-600 bg-red-500/10 border-red-500/20' },
];
