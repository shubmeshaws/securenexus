'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Boxes,
  CircleAlert,
  CircleX,
  CloudCog,
  FileKey,
  Icons,
  Loader2,
  RefreshCcw,
  Trash2,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch, type RegisteredCluster } from '@/lib/api-client';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
import { AddClusterDialog } from '@/components/pod-scheduler/add-cluster-dialog';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { ClusterTreeView } from '@/components/pod-scheduler/cluster-tree-view';
import { DeploymentDetailPanel } from '@/components/pod-scheduler/deployment-detail-panel';
import {
  PageHeader, StatCard, GlassPanel, EmptyState, TabBar,
} from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

const STATUS_CONFIG = {
  connected: { icon: BadgeCheck, dot: 'bg-emerald-400', badge: 'success' as const, label: 'Connected' },
  disconnected: { icon: CircleX, dot: 'bg-zinc-500', badge: 'unknown' as const, label: 'Disconnected' },
  error: { icon: CircleAlert, dot: 'bg-red-400', badge: 'failed' as const, label: 'Error' },
};

export function ClustersPageContent() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('registry');
  const [clusterToRemove, setClusterToRemove] = useState<RegisteredCluster | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['registered-clusters'],
    queryFn: () => apiFetch<{ clusters: RegisteredCluster[]; total: number }>('/api/clusters/registry'),
    refetchInterval: POLL_INTERVAL,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/clusters/registry/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setClusterToRemove(null);
      queryClient.invalidateQueries({ queryKey: ['registered-clusters'] });
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.invalidateQueries({ queryKey: ['infrastructure'] });
    },
  });

  const clusters = data?.clusters ?? [];
  const connected = clusters.filter((c) => c.status === 'connected').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Clusters"
        description={`${connected} of ${clusters.length} cluster${clusters.length !== 1 ? 's' : ''} connected — manage kubeconfig and AWS EKS integrations.`}
        action={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <AppIcon icon={Icons.actions.add} size="sm" />
            Add Cluster
          </Button>
        }
      />

      <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total" value={clusters.length} icon={Boxes} accent="blue" />
        <StatCard label="Connected" value={connected} icon={BadgeCheck} accent="emerald" />
        <StatCard label="Kubeconfig" value={clusters.filter((c) => c.provider === 'kubeconfig').length} icon={FileKey} accent="sky" />
        <StatCard label="AWS EKS" value={clusters.filter((c) => c.provider === 'aws').length} icon={CloudCog} accent="amber" />
      </div>

      <TabBar
        tabs={[
          { id: 'registry', label: 'Connected Clusters' },
          { id: 'explorer', label: 'Cluster Explorer' },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'registry' ? (
        isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
          </div>
        ) : clusters.length === 0 ? (
          <GlassPanel>
            <EmptyState
              icon={Boxes}
              title="No clusters connected"
              description="Add your first cluster using a local kubeconfig file or AWS credentials for EKS."
              action={
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <AppIcon icon={Icons.actions.add} size="sm" />
                  Add Cluster
                </Button>
              }
            />
          </GlassPanel>
        ) : (
          <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {clusters.map((cluster) => (
              <ClusterCard
                key={cluster.id}
                cluster={cluster}
                onDelete={() => setClusterToRemove(cluster)}
                deleting={deleteMutation.isPending && clusterToRemove?.id === cluster.id}
              />
            ))}
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 min-h-[420px]">
          <GlassPanel className="lg:col-span-2 p-4 overflow-y-auto max-h-[65vh] scrollbar-thin">
            <ClusterTreeView />
          </GlassPanel>
          <GlassPanel className="lg:col-span-3 min-h-[420px] overflow-y-auto scrollbar-thin">
            <DeploymentDetailPanel />
          </GlassPanel>
        </div>
      )}

      {addOpen && <AddClusterDialog open onClose={() => setAddOpen(false)} />}

      <ConfirmDialog
        open={clusterToRemove !== null}
        onOpenChange={(open) => !open && setClusterToRemove(null)}
        title="Remove cluster?"
        description={
          <>
            Remove <span className="font-medium text-foreground">{clusterToRemove?.name}</span> from
            SecureNexus? This disconnects the cluster and removes its stored kubeconfig. Schedules
            targeting this cluster will no longer run.
          </>
        }
        confirmLabel="Remove"
        onConfirm={() => clusterToRemove && deleteMutation.mutate(clusterToRemove.id)}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}

function ClusterCard({
  cluster,
  onDelete,
  deleting,
}: {
  cluster: RegisteredCluster;
  onDelete: () => void;
  deleting: boolean;
}) {
  const cfg = STATUS_CONFIG[cluster.status] ?? STATUS_CONFIG.disconnected;

  return (
    <div className="glass-panel-hover w-full min-w-0 space-y-3 p-4 group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br',
              cluster.provider === 'aws'
                ? 'from-amber-500/20 to-orange-500/10'
                : 'from-blue-500/20 to-sky-500/10'
            )}
          >
            {cluster.provider === 'aws' ? (
              <AppIcon icon={CloudCog} size="lg" className="text-amber-400" />
            ) : (
              <AppIcon icon={FileKey} size="lg" className="text-blue-500 dark:text-blue-400" />
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{cluster.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {cluster.provider === 'aws'
                ? `EKS · ${cluster.region}`
                : `Context · ${cluster.contextName ?? cluster.name}`}
            </p>
          </div>
        </div>
        <Badge variant={cfg.badge}>
          <span className={cn('inline-block h-1.5 w-1.5 rounded-full mr-1.5', cfg.dot)} />
          {cfg.label}
        </Badge>
      </div>

      {(cluster.kubeconfigPath || cluster.serverUrl || cluster.awsClusterName) && (
        <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2">
          <p className="truncate text-[11px] font-mono text-muted-foreground">
            {cluster.kubeconfigPath ?? cluster.serverUrl ?? cluster.awsClusterName}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-1">
        <p className="text-[11px] text-muted-foreground">
          Added by <span className="text-foreground">{cluster.addedByName ?? 'unknown'}</span>
          {cluster.lastSyncAt && (
            <> · synced {formatRelativeTime(cluster.lastSyncAt)}</>
          )}
        </p>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button type="button" className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Refresh">
            <AppIcon icon={RefreshCcw} size="sm" />
          </button>
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
            title="Remove"
            onClick={onDelete}
            disabled={deleting}
          >
            <AppIcon icon={Trash2} size="sm" />
          </button>
        </div>
      </div>
    </div>
  );
}
