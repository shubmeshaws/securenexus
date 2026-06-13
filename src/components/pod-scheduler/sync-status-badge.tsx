'use client';

import { Loader2 } from '@/lib/icons';
import { Badge } from '@/components/ui/badge';
import type { ArgoCDApp } from '@/lib/api-client';

type SyncStatus = ArgoCDApp['syncStatus'];

const variantMap: Record<SyncStatus, 'synced' | 'outOfSync' | 'unknown' | 'progressing'> = {
  Synced: 'synced',
  OutOfSync: 'outOfSync',
  Unknown: 'unknown',
  Progressing: 'progressing',
};

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  return (
    <Badge variant={variantMap[status] ?? 'unknown'} className="gap-1">
      {status === 'Progressing' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status}
    </Badge>
  );
}

export function SyncPolicyBadge({ policy }: { policy: 'automated' | 'none' }) {
  return (
    <Badge variant={policy === 'automated' ? 'automated' : 'manual'}>
      {policy === 'automated' ? 'Automated' : 'Manual'}
    </Badge>
  );
}

export function ReplicaBadge({ current, desired }: { current: number; desired: number }) {
  return (
    <Badge variant="replicas">
      {current}/{desired}
    </Badge>
  );
}

export function PodStatusDot({ status }: { status: string }) {
  const color =
    status === 'Running'
      ? 'bg-emerald-500'
      : status === 'Pending'
        ? 'bg-amber-500'
        : status.includes('Crash') || status === 'Failed'
          ? 'bg-red-500'
          : 'bg-zinc-500';

  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}
