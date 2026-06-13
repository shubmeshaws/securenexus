'use client';

import { memo, useCallback } from 'react';
import { SyncStatusBadge, PodStatusDot } from '@/components/pod-scheduler/sync-status-badge';
import { ScaleControl } from '@/components/pod-scheduler/scale-control';
import { SyncPolicyToggle } from '@/components/pod-scheduler/sync-policy-toggle';
import type { ArgoCDApp, Deployment } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface DeploymentCardProps {
  cluster: string;
  namespace: string;
  deployment: Deployment;
  argo?: ArgoCDApp;
  isSelected: boolean;
  onSelect: () => void;
}

export const DeploymentCard = memo(function DeploymentCard({
  cluster,
  namespace,
  deployment,
  argo,
  isSelected,
  onSelect,
}: DeploymentCardProps) {
  const handleSelect = useCallback(() => onSelect(), [onSelect]);

  return (
    <button
      type="button"
      onClick={handleSelect}
      className={cn(
        'w-full cursor-pointer rounded-lg border p-2 text-left space-y-2',
        'border-border hover:border-blue-300 hover:bg-blue-50/50 dark:hover:border-blue-500/40 dark:hover:bg-blue-500/5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60',
        isSelected && 'border-blue-400 bg-blue-100 ring-1 ring-blue-300/80 dark:border-blue-500/40 dark:bg-blue-500/10 dark:ring-0'
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="font-mono text-xs font-medium text-foreground truncate">{deployment.name}</span>
        {argo && <SyncStatusBadge status={argo.syncStatus} />}
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <ScaleControl
          cluster={cluster}
          namespace={namespace}
          name={deployment.name}
          desiredReplicas={deployment.desiredReplicas}
          readyReplicas={deployment.readyReplicas}
          compact
        />
        {argo && (
          <SyncPolicyToggle
            appName={argo.name}
            instanceId={argo.instanceId}
            syncPolicy={argo.syncPolicy}
          />
        )}
      </div>
      {deployment.pods && deployment.pods.length > 0 && (
        <ul className="pointer-events-none space-y-1 pl-2">
          {deployment.pods.map((pod) => (
            <li key={pod.name} className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
              <PodStatusDot status={pod.status} />
              <span className="truncate text-foreground/80">{pod.name}</span>
              <span>{pod.status}</span>
            </li>
          ))}
        </ul>
      )}
    </button>
  );
});
