import { listClusterDeployments, listClusters, type DeploymentInfo } from '@/lib/k8s-client';

const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const CACHE_TTL_MS = 60_000;
const SCAN_TIMEOUT_MS = 12_000;

export interface ClusterWorkload {
  total: number;
  running: number;
  stopped: number;
}

export interface WorkloadSummary {
  totalApps: number;
  running: number;
  stopped: number;
  k8sUnavailable: boolean;
  byCluster: Record<string, ClusterWorkload>;
}

let cache: { at: number; summary: WorkloadSummary } | null = null;

export function invalidateWorkloadCache() {
  cache = null;
}

function tallyDeployments(deps: DeploymentInfo[]): ClusterWorkload {
  let total = 0;
  let running = 0;
  let stopped = 0;

  for (const dep of deps) {
    if (dep.namespace && SYSTEM_NAMESPACES.has(dep.namespace)) continue;
    total++;
    if ((dep.desiredReplicas ?? 0) > 0) running++;
    else stopped++;
  }

  return { total, running, stopped };
}

async function scanFresh(): Promise<WorkloadSummary> {
  const clusters = await listClusters();
  if (!clusters.length) {
    return { totalApps: 0, running: 0, stopped: 0, k8sUnavailable: true, byCluster: {} };
  }

  const byCluster: Record<string, ClusterWorkload> = {};
  let totalApps = 0;
  let running = 0;
  let stopped = 0;
  let anySuccess = false;

  const results = await Promise.all(
    clusters.map(async (cluster) => {
      try {
        const deps = await listClusterDeployments(cluster.name);
        const tally = tallyDeployments(deps);
        return { name: cluster.name, tally, ok: true as const };
      } catch {
        return {
          name: cluster.name,
          tally: { total: 0, running: 0, stopped: 0 },
          ok: false as const,
        };
      }
    })
  );

  for (const result of results) {
    byCluster[result.name] = result.tally;
    if (result.ok) anySuccess = true;
    totalApps += result.tally.total;
    running += result.tally.running;
    stopped += result.tally.stopped;
  }

  return {
    totalApps,
    running,
    stopped,
    k8sUnavailable: !anySuccess,
    byCluster,
  };
}

export async function getWorkloadSummary(): Promise<WorkloadSummary> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.summary;
  }

  try {
    const summary = await Promise.race([
      scanFresh(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Kubernetes scan timed out')), SCAN_TIMEOUT_MS)
      ),
    ]);
    cache = { at: Date.now(), summary };
    return summary;
  } catch {
    if (cache) {
      return { ...cache.summary, k8sUnavailable: true };
    }
    return { totalApps: 0, running: 0, stopped: 0, k8sUnavailable: true, byCluster: {} };
  }
}
