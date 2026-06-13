'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FolderKanban, Loader2, ServerCog } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { apiFetch, type ArgoCDApp, type Deployment } from '@/lib/api-client';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
import { DeploymentCard } from '@/components/pod-scheduler/cluster-deployment-card';
import { usePodSchedulerStore } from '@/store/pod-scheduler';
import { cn } from '@/lib/utils';

interface ClusterInfo {
  name: string;
  context: string;
}

function findArgoApp(apps: ArgoCDApp[], depName: string, ns: string) {
  return apps.find(
    (a) => a.name === depName || (a.destinationNamespace === ns && a.name.includes(depName))
  );
}

export function ClusterTreeView({
  onSelectDeployment,
}: {
  onSelectDeployment?: (cluster: string, ns: string, dep: Deployment) => void;
}) {
  const selectedCluster = usePodSchedulerStore((s) => s.selectedCluster);
  const selectedNamespace = usePodSchedulerStore((s) => s.selectedNamespace);
  const selectedDeployment = usePodSchedulerStore((s) => s.selectedDeployment);
  const setSelectedCluster = usePodSchedulerStore((s) => s.setSelectedCluster);
  const selectNamespace = usePodSchedulerStore((s) => s.selectNamespace);
  const selectDeployment = usePodSchedulerStore((s) => s.selectDeployment);

  const { data: clustersData } = useQuery({
    queryKey: ['clusters'],
    queryFn: () => apiFetch<{ clusters: ClusterInfo[] }>('/api/k8s/clusters'),
    refetchInterval: POLL_INTERVAL,
  });

  const { data: argocdData } = useQuery({
    queryKey: ['argocd-apps'],
    queryFn: () => apiFetch<{ apps: ArgoCDApp[]; degraded?: boolean }>('/api/argocd/apps'),
    refetchInterval: POLL_INTERVAL,
  });

  const clusters = clustersData?.clusters ?? [];
  const argocdApps = argocdData?.apps ?? [];

  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const [expandedNs, setExpandedNs] = useState<Set<string>>(new Set());

  function toggleSet(setter: Dispatch<SetStateAction<Set<string>>>, key: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-1 text-sm">
      {clusters.length === 0 && (
        <p className="text-muted-foreground text-xs p-4 leading-relaxed">
          No clusters to explore. Add a cluster under Connected Clusters first.
        </p>
      )}
      {clusters.map((cluster) => (
        <ClusterNode
          key={cluster.name}
          cluster={cluster.name}
          expanded={expandedClusters.has(cluster.name)}
          onToggle={() => toggleSet(setExpandedClusters, cluster.name)}
          expandedNs={expandedNs}
          onToggleNs={(ns) => toggleSet(setExpandedNs, `${cluster.name}/${ns}`)}
          argocdApps={argocdApps}
          selectedCluster={selectedCluster}
          selectedNamespace={selectedNamespace}
          selectedDeployment={selectedDeployment}
          onSelectCluster={setSelectedCluster}
          onSelectNs={(ns) => selectNamespace(cluster.name, ns)}
          onSelectDep={(ns, dep) => {
            selectDeployment(cluster.name, ns, dep.name);
            onSelectDeployment?.(cluster.name, ns, dep);
          }}
        />
      ))}
    </div>
  );
}

function ClusterNode({
  cluster,
  expanded,
  onToggle,
  expandedNs,
  onToggleNs,
  argocdApps,
  selectedCluster,
  selectedNamespace,
  selectedDeployment,
  onSelectCluster,
  onSelectNs,
  onSelectDep,
}: {
  cluster: string;
  expanded: boolean;
  onToggle: () => void;
  expandedNs: Set<string>;
  onToggleNs: (ns: string) => void;
  argocdApps: ArgoCDApp[];
  selectedCluster: string | null;
  selectedNamespace: string | null;
  selectedDeployment: string | null;
  onSelectCluster: (c: string) => void;
  onSelectNs: (ns: string) => void;
  onSelectDep: (ns: string, dep: Deployment) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () =>
      apiFetch<{ namespaces: string[] }>(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces`
      ),
    enabled: expanded,
    refetchInterval: POLL_INTERVAL,
  });

  const namespaces = data?.namespaces ?? [];

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onToggle();
          onSelectCluster(cluster);
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800',
          selectedCluster === cluster && !selectedNamespace &&
            'bg-blue-100 text-zinc-900 ring-1 ring-blue-300/80 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-0'
        )}
      >
        {expanded ? (
          <AppIcon icon={ChevronDown} className="text-muted-foreground" />
        ) : (
          <AppIcon icon={ChevronRight} className="text-muted-foreground" />
        )}
        <AppIcon icon={ServerCog} className="text-blue-500 dark:text-blue-400" />
        <span className={cn('font-medium', selectedCluster === cluster && !selectedNamespace ? 'text-zinc-900 dark:text-zinc-100' : 'text-foreground')}>{cluster}</span>
      </button>
      {expanded && (
        <div className="ml-4 border-l border-border pl-2 mt-1">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground my-2" />}
          {namespaces.map((ns) => (
            <NamespaceNode
              key={ns}
              cluster={cluster}
              namespace={ns}
              expanded={expandedNs.has(`${cluster}/${ns}`)}
              onToggle={() => onToggleNs(ns)}
              argocdApps={argocdApps}
              selectedCluster={selectedCluster}
              selectedNamespace={selectedNamespace}
              selectedDeployment={selectedDeployment}
              onSelectNs={onSelectNs}
              onSelectDep={onSelectDep}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NamespaceNode({
  cluster,
  namespace,
  expanded,
  onToggle,
  argocdApps,
  selectedCluster,
  selectedNamespace,
  selectedDeployment,
  onSelectNs,
  onSelectDep,
}: {
  cluster: string;
  namespace: string;
  expanded: boolean;
  onToggle: () => void;
  argocdApps: ArgoCDApp[];
  selectedCluster: string | null;
  selectedNamespace: string | null;
  selectedDeployment: string | null;
  onSelectNs: (ns: string) => void;
  onSelectDep: (ns: string, dep: Deployment) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['deployments', cluster, namespace],
    queryFn: () =>
      apiFetch<{ deployments: Deployment[] }>(
        `/api/k8s/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(namespace)}/deployments`
      ),
    enabled: expanded,
    refetchInterval: POLL_INTERVAL,
  });

  const deployments = data?.deployments ?? [];

  const isNsActive =
    selectedCluster === cluster && selectedNamespace === namespace && !selectedDeployment;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onToggle();
          onSelectNs(namespace);
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800',
          isNsActive &&
            'bg-blue-100 text-zinc-900 ring-1 ring-blue-300/80 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-0'
        )}
      >
        {expanded ? (
          <AppIcon icon={ChevronDown} size="sm" className="text-muted-foreground" />
        ) : (
          <AppIcon icon={ChevronRight} size="sm" className="text-muted-foreground" />
        )}
        <AppIcon icon={FolderKanban} size="sm" className="text-amber-600 dark:text-amber-400" />
        <span className={cn(isNsActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-foreground')}>{namespace}</span>
      </button>
      {expanded && (
        <div className="ml-4 border-l border-border pl-2 mt-1 space-y-2">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground my-2" />}
          {deployments.map((dep) => {
            const argo = findArgoApp(argocdApps, dep.name, namespace);
            const isSelected =
              selectedCluster === cluster &&
              selectedNamespace === namespace &&
              selectedDeployment === dep.name;
            return (
              <DeploymentCard
                key={dep.name}
                cluster={cluster}
                namespace={namespace}
                deployment={dep}
                argo={argo}
                isSelected={isSelected}
                onSelect={() => onSelectDep(namespace, dep)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
