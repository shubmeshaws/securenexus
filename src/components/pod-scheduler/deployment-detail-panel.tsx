'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Cpu, Loader2 } from '@/lib/icons';
import { ModernIcon } from '@/components/ui/modern-icon';
import { apiFetch, type ArgoCDApp, type Deployment } from '@/lib/api-client';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
import { SyncStatusBadge, SyncPolicyBadge } from '@/components/pod-scheduler/sync-status-badge';
import { ScaleControl } from '@/components/pod-scheduler/scale-control';
import { SyncPolicyToggle } from '@/components/pod-scheduler/sync-policy-toggle';
import { PodStatusDot } from '@/components/pod-scheduler/sync-status-badge';
import { formatRelativeTime, parseClusterDisplay } from '@/lib/utils';
import { usePodSchedulerStore } from '@/store/pod-scheduler';

export function DeploymentDetailPanel() {
  const selectedCluster = usePodSchedulerStore((s) => s.selectedCluster);
  const selectedNamespace = usePodSchedulerStore((s) => s.selectedNamespace);
  const selectedDeployment = usePodSchedulerStore((s) => s.selectedDeployment);

  const { data: depData, isLoading, refetch } = useQuery({
    queryKey: ['deployments', selectedCluster, selectedNamespace],
    queryFn: () =>
      apiFetch<{ deployments: Deployment[] }>(
        `/api/k8s/clusters/${encodeURIComponent(selectedCluster!)}/namespaces/${encodeURIComponent(selectedNamespace!)}/deployments`
      ),
    enabled: Boolean(selectedCluster && selectedNamespace),
    refetchInterval: POLL_INTERVAL,
    placeholderData: keepPreviousData,
  });

  const { data: argocdData } = useQuery({
    queryKey: ['argocd-apps'],
    queryFn: () => apiFetch<{ apps: ArgoCDApp[] }>('/api/argocd/apps'),
    refetchInterval: POLL_INTERVAL,
  });

  if (!selectedCluster || !selectedNamespace || !selectedDeployment) {
    return (
      <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 p-6 text-center">
        <ModernIcon icon={Cpu} accent="sky" size="lg" />
        <p className="text-sm font-medium text-foreground">Select a deployment from the tree</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Expand a cluster and namespace, then click a deployment card to view details here.
        </p>
      </div>
    );
  }

  if (isLoading && !depData) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500/50" />
      </div>
    );
  }

  const deployment = depData?.deployments.find((d) => d.name === selectedDeployment);
  if (!deployment) {
    return <p className="p-4 text-sm text-muted-foreground">Deployment not found</p>;
  }

  const argo = argocdData?.apps.find(
    (a) =>
      a.name === selectedDeployment ||
      (a.destinationNamespace === selectedNamespace && a.name.includes(selectedDeployment))
  );

  const { clusterName } = parseClusterDisplay(selectedCluster);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h2 className="font-mono text-lg font-semibold text-foreground">{deployment.name}</h2>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {clusterName} / {selectedNamespace}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Desired" value={deployment.desiredReplicas} />
        <Stat label="Ready" value={deployment.readyReplicas} />
        <Stat label="Available" value={deployment.availableReplicas} />
        <Stat label="Total" value={deployment.replicas} />
      </div>

      {argo && (
        <div className="flex flex-wrap items-center gap-3">
          <SyncStatusBadge status={argo.syncStatus} />
          <SyncPolicyBadge policy={argo.syncPolicy} />
          {argo.lastSyncedAt && (
            <span className="font-mono text-[10px] text-muted-foreground">
              Last synced {formatRelativeTime(argo.lastSyncedAt)}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <ScaleControl
          cluster={selectedCluster}
          namespace={selectedNamespace}
          name={deployment.name}
          desiredReplicas={deployment.desiredReplicas}
          readyReplicas={deployment.readyReplicas}
          onScaled={() => refetch()}
        />
        {argo && (
          <SyncPolicyToggle
            appName={argo.name}
            instanceId={argo.instanceId}
            syncPolicy={argo.syncPolicy}
          />
        )}
      </div>

      <div>
        <h3 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">Pods</h3>
        {!deployment.pods?.length ? (
          <p className="font-mono text-xs text-muted-foreground">No pods</p>
        ) : (
          <ul className="space-y-2">
            {deployment.pods.map((pod) => (
              <li
                key={pod.name}
                className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs font-mono"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <PodStatusDot status={pod.status} />
                  <span className="truncate text-foreground">{pod.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-muted-foreground">
                  <span>{pod.status}</span>
                  <span>{pod.ready}</span>
                  <span>{pod.age}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
    </div>
  );
}
