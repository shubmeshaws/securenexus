'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  CalendarRange,
  CirclePlay,
  CircleStop,
  CloudCog,
  Cpu,
  Loader2,
  ServerCog,
  Timer,
  TriangleAlert,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch, type InfrastructureOverview, type InfrastructureCluster, type InfraState } from '@/lib/api-client';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
import { PageHeader, StatCard, GlassPanel, EmptyState } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

const INFRA_STATE: Record<InfraState, { label: string; badge: 'success' | 'failed' | 'outOfSync' | 'unknown'; dot: string }> = {
  running: { label: 'Running', badge: 'success', dot: 'bg-emerald-400' },
  stopped: { label: 'Stopped', badge: 'failed', dot: 'bg-zinc-400' },
  partial: { label: 'Partial', badge: 'outOfSync', dot: 'bg-amber-400' },
  starting: { label: 'Starting', badge: 'unknown', dot: 'bg-blue-400 animate-pulse' },
  stopping: { label: 'Stopping', badge: 'unknown', dot: 'bg-orange-400 animate-pulse' },
};

export function InfrastructurePageContent() {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<{ cluster: InfrastructureCluster; action: 'start' | 'stop' } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['infrastructure'],
    queryFn: () => apiFetch<InfrastructureOverview>('/api/infrastructure/overview'),
    refetchInterval: POLL_INTERVAL,
  });

  const controlMutation = useMutation({
    mutationFn: ({ clusterName, action }: { clusterName: string; action: 'start' | 'stop' }) =>
      apiFetch('/api/infrastructure/control', {
        method: 'POST',
        body: JSON.stringify({ clusterName, action }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['infrastructure'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setPendingAction(null);
    },
  });

  const summary = data?.summary ?? { total: 0, running: 0, stopped: 0, partial: 0 };
  const clusters = data?.clusters ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Infrastructure"
        description="Start and stop EKS workloads across your clusters. Scale deployments to zero overnight and restore them on schedule."
        action={
          <Link href="/schedules">
            <Button variant="outline" size="sm">
              <AppIcon icon={CalendarRange} size="sm" />
              Manage Schedules
            </Button>
          </Link>
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
        </div>
      ) : (
        <>
          <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Total Clusters" value={summary.total} icon={ServerCog} accent="blue" />
            <StatCard label="Running" value={summary.running} icon={CirclePlay} accent="emerald" />
            <StatCard label="Stopped" value={summary.stopped} icon={CircleStop} accent="red" />
            <StatCard label="Partial" value={summary.partial} icon={TriangleAlert} accent="amber" />
          </div>

          {clusters.length === 0 ? (
            <GlassPanel>
              <EmptyState
                icon={Cpu}
                title="No infrastructure connected"
                description="Register an EKS or kubeconfig cluster to start controlling your infrastructure."
                action={
                  <Link href="/clusters">
                    <Button size="sm">
                      <AppIcon icon={Boxes} size="sm" />
                      Add Cluster
                    </Button>
                  </Link>
                }
              />
            </GlassPanel>
          ) : (
            <div className="grid w-full grid-cols-1 gap-3 xl:grid-cols-2">
              {clusters.map((cluster) => (
                <ClusterInfraCard
                  key={cluster.id}
                  cluster={cluster}
                  onAction={(action) => setPendingAction({ cluster, action })}
                  isBusy={controlMutation.isPending && pendingAction?.cluster.id === cluster.id}
                />
              ))}
            </div>
          )}
        </>
      )}

      <Dialog open={pendingAction !== null} onOpenChange={() => setPendingAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.action === 'stop' ? 'Stop infrastructure?' : 'Start infrastructure?'}
            </DialogTitle>
            <DialogDescription>
              {pendingAction?.action === 'stop'
                ? `This will scale all deployments in "${pendingAction?.cluster.name}" to 0 replicas and pause ArgoCD sync where matched.`
                : `This will restore all stopped deployments in "${pendingAction?.cluster.name}" to their default replica count.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>Cancel</Button>
            <Button
              variant={pendingAction?.action === 'stop' ? 'destructive' : 'success'}
              disabled={controlMutation.isPending}
              onClick={() => {
                if (pendingAction) {
                  controlMutation.mutate({
                    clusterName: pendingAction.cluster.name,
                    action: pendingAction.action,
                  });
                }
              }}
            >
              {controlMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : pendingAction?.action === 'stop' ? (
                'Stop Infrastructure'
              ) : (
                'Start Infrastructure'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClusterInfraCard({
  cluster,
  onAction,
  isBusy,
}: {
  cluster: InfrastructureCluster;
  onAction: (action: 'start' | 'stop') => void;
  isBusy: boolean;
}) {
  const state = INFRA_STATE[cluster.infraState];
  const canStart = cluster.infraState !== 'running' && cluster.status === 'connected';
  const canStop = cluster.infraState !== 'stopped' && cluster.status === 'connected';
  const ProviderIcon = cluster.provider === 'aws' ? CloudCog : ServerCog;

  return (
    <GlassPanel className="flex flex-col p-0 overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/30 to-sky-600/10 ring-1 ring-blue-500/20">
              <AppIcon icon={ProviderIcon} size="lg" className="text-blue-500 dark:text-blue-400" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate font-semibold text-foreground">{cluster.name}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {cluster.provider === 'aws'
                  ? `EKS · ${cluster.region} · ${cluster.awsClusterName}`
                  : 'Kubeconfig cluster'}
              </p>
            </div>
          </div>
          <Badge variant={state.badge}>{state.label}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px bg-border">
        <MetricCell label="Workloads" value={`${cluster.workloads.running}/${cluster.workloads.total}`} />
        <MetricCell label="Schedules" value={cluster.activeSchedules} />
        <MetricCell label="Savings" value={cluster.estimatedSavingsPct > 0 ? `${cluster.estimatedSavingsPct}%` : '—'} />
      </div>

      {cluster.nodeGroups.length > 0 && (
        <div className="border-b border-border px-5 py-3">
          <p className="mb-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Node Groups</p>
          <div className="space-y-1.5">
            {cluster.nodeGroups.map((ng) => (
              <div key={ng.name} className="flex items-center justify-between text-xs">
                <span className="font-mono text-muted-foreground">{ng.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-foreground">{ng.desired} nodes</span>
                  <span className={cn('h-1.5 w-1.5 rounded-full', ng.status === 'active' ? 'bg-emerald-400' : ng.status === 'stopped' ? 'bg-zinc-400' : 'bg-amber-400 animate-pulse')} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {cluster.lastActionAt && (
        <div className="flex items-center gap-2 border-b border-border px-5 py-2.5 text-xs text-muted-foreground">
          <AppIcon icon={Timer} size="sm" />
          Last {cluster.lastAction} {formatRelativeTime(cluster.lastActionAt)}
        </div>
      )}

      {cluster.status !== 'connected' && (
        <div className="flex items-center gap-2 border-b border-border bg-amber-500/5 px-5 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          <AppIcon icon={TriangleAlert} size="sm" className="shrink-0" />
          Cluster disconnected — reconnect before controlling infrastructure
        </div>
      )}

      <div className="mt-auto flex gap-2 p-4">
        <Button
          variant="danger"
          size="sm"
          className="flex-1"
          disabled={!canStop || isBusy}
          onClick={() => onAction('stop')}
        >
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AppIcon icon={CircleStop} size="sm" />}
          Stop
        </Button>
        <Button
          variant="success"
          size="sm"
          className="flex-1"
          disabled={!canStart || isBusy}
          onClick={() => onAction('start')}
        >
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AppIcon icon={CirclePlay} size="sm" />}
          Start
        </Button>
      </div>
    </GlassPanel>
  );
}

function MetricCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-card px-4 py-3 text-center">
      <p className="text-lg font-bold text-foreground">{value}</p>
      <p className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
