import * as k8s from '@kubernetes/client-node';
import prisma from '@/lib/prisma';
import { readKubeconfigFromPath } from '@/lib/kubeconfig-file';
import { buildEksKubeConfigForRegisteredCluster } from '@/lib/eks-kubeconfig';
export interface ClusterInfo {
  name: string;
  context: string;
  server: string;
  current: boolean;
}

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

export interface WorkloadInfo {
  name: string;
  kind: WorkloadKind;
  namespace: string;
  cluster: string;
}

export interface DeploymentInfo {
  name: string;
  namespace: string;
  cluster: string;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  desiredReplicas: number;
  labels: Record<string, string>;
  matchLabels: Record<string, string>;
  createdAt: string | null;
}

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  age: string;
  nodeName: string | null;
}

type RegisteredCluster = NonNullable<Awaited<ReturnType<typeof prisma.cluster.findFirst>>>;
let registeredClustersCache: { at: number; byName: Map<string, RegisteredCluster> } | null = null;
const REGISTERED_CACHE_TTL_MS = 30_000;

export function invalidateKubeConfigCache() {
  registeredClustersCache = null;
}

async function getRegisteredCluster(clusterName: string): Promise<RegisteredCluster | null> {
  if (
    !registeredClustersCache ||
    Date.now() - registeredClustersCache.at >= REGISTERED_CACHE_TTL_MS
  ) {
    const rows = await prisma.cluster.findMany({
      where: { status: 'connected' },
    });
    registeredClustersCache = {
      at: Date.now(),
      byName: new Map(rows.map((row) => [row.name, row])),
    };
  }
  return registeredClustersCache.byName.get(clusterName) ?? null;
}

async function getRegisteredClusters() {
  if (
    !registeredClustersCache ||
    Date.now() - registeredClustersCache.at >= REGISTERED_CACHE_TTL_MS
  ) {
    const rows = await prisma.cluster.findMany({
      where: { status: 'connected' },
      orderBy: { createdAt: 'asc' },
    });
    registeredClustersCache = {
      at: Date.now(),
      byName: new Map(rows.map((row) => [row.name, row])),
    };
  }
  return Array.from(registeredClustersCache.byName.values());
}

function resolveClusterKubeconfigB64(registered: RegisteredCluster | null): string | null {
  if (!registered) return null;
  if (registered.kubeconfigB64) return registered.kubeconfigB64;
  if (registered.kubeconfigPath) {
    try {
      return readKubeconfigFromPath(registered.kubeconfigPath).kubeconfigB64;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveContextName(kc: k8s.KubeConfig, preferred?: string | null): string | null {
  const contexts = kc.getContexts().filter((ctx) => Boolean(ctx.name));
  if (!contexts.length) return null;

  if (preferred) {
    const exact = contexts.find((ctx) => ctx.name === preferred);
    if (exact?.name) return exact.name;

    const byCluster = contexts.find((ctx) => ctx.cluster === preferred);
    if (byCluster?.name) return byCluster.name;
  }

  const current = kc.getCurrentContext();
  if (current && contexts.some((ctx) => ctx.name === current)) return current;

  return contexts[0]?.name ?? null;
}

function loadKubeConfigFromBase64(base64: string, contextName?: string | null): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');
  kc.loadFromString(decoded);

  const resolved = resolveContextName(kc, contextName);
  if (resolved) kc.setCurrentContext(resolved);

  return kc;
}

async function getConfigForCluster(clusterName: string): Promise<k8s.KubeConfig> {
  const registered = await getRegisteredCluster(clusterName);
  if (!registered) {
    throw new Error(
      `Cluster "${clusterName}" is not registered. Add it under Clusters → Add Cluster first.`
    );
  }

  if (registered.provider !== 'kubeconfig') {
    throw new Error(`Cluster "${clusterName}" uses provider "${registered.provider}" — K8s API access is not configured yet.`);
  }

  const registeredB64 = resolveClusterKubeconfigB64(registered);

  const fromAwsIntegration = await buildEksKubeConfigForRegisteredCluster({
    registeredName: clusterName,
    contextName: registered.contextName ?? clusterName,
    kubeconfigB64: registeredB64,
    region: registered.region,
  });
  if (fromAwsIntegration) return fromAwsIntegration;

  if (!registeredB64) {
    throw new Error(`Cluster "${clusterName}" has no kubeconfig stored. Re-add the cluster with a valid kubeconfig.`);
  }

  return loadKubeConfigFromBase64(registeredB64, registered.contextName ?? clusterName);
}

function mapDeployment(
  dep: k8s.V1Deployment,
  cluster: string,
  namespace: string
): DeploymentInfo {
  return {
    name: dep.metadata?.name ?? 'unknown',
    namespace: dep.metadata?.namespace ?? namespace,
    cluster,
    replicas: dep.status?.replicas ?? 0,
    readyReplicas: dep.status?.readyReplicas ?? 0,
    availableReplicas: dep.status?.availableReplicas ?? 0,
    desiredReplicas: dep.spec?.replicas ?? 0,
    labels: dep.metadata?.labels ?? {},
    matchLabels: dep.spec?.selector?.matchLabels ?? {},
    createdAt: dep.metadata?.creationTimestamp?.toISOString() ?? null,
  };
}

export async function listClusters(): Promise<ClusterInfo[]> {
  const registered = await getRegisteredClusters();
  return registered.map((reg) => ({
    name: reg.name,
    context: reg.contextName ?? reg.name,
    server: reg.serverUrl ?? 'configured',
    current: false,
  }));
}

export async function listNamespaces(cluster: string): Promise<string[]> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.CoreV1Api);
  const res = await api.listNamespace();
  return (res.body.items ?? [])
    .map((ns) => ns.metadata?.name)
    .filter((n): n is string => Boolean(n))
    .sort();
}

export async function listDeployments(cluster: string, namespace: string): Promise<DeploymentInfo[]> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.AppsV1Api);
  const res = await api.listNamespacedDeployment(namespace);
  return (res.body.items ?? []).map((dep) => mapDeployment(dep, cluster, namespace));
}

export async function listWorkloads(cluster: string, namespace: string): Promise<WorkloadInfo[]> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.AppsV1Api);

  const [deployments, statefulSets, daemonSets] = await Promise.all([
    api.listNamespacedDeployment(namespace).catch(() => ({ body: { items: [] as k8s.V1Deployment[] } })),
    api.listNamespacedStatefulSet(namespace).catch(() => ({ body: { items: [] as k8s.V1StatefulSet[] } })),
    api.listNamespacedDaemonSet(namespace).catch(() => ({ body: { items: [] as k8s.V1DaemonSet[] } })),
  ]);

  const workloads: WorkloadInfo[] = [];

  for (const dep of deployments.body.items ?? []) {
    const name = dep.metadata?.name;
    if (name) workloads.push({ name, kind: 'Deployment', namespace, cluster });
  }
  for (const sts of statefulSets.body.items ?? []) {
    const name = sts.metadata?.name;
    if (name) workloads.push({ name, kind: 'StatefulSet', namespace, cluster });
  }
  for (const ds of daemonSets.body.items ?? []) {
    const name = ds.metadata?.name;
    if (name) workloads.push({ name, kind: 'DaemonSet', namespace, cluster });
  }

  return workloads.sort((a, b) => a.name.localeCompare(b.name));
}

export async function detectWorkloadKind(
  cluster: string,
  namespace: string,
  name: string
): Promise<WorkloadKind | null> {
  const workloads = await listWorkloads(cluster, namespace);
  return workloads.find((w) => w.name === name)?.kind ?? null;
}

export async function listAllDeployments(cluster: string): Promise<DeploymentInfo[]> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.AppsV1Api);
  const res = await api.listDeploymentForAllNamespaces();
  return (res.body.items ?? []).map((dep) =>
    mapDeployment(dep, cluster, dep.metadata?.namespace ?? 'default')
  );
}

const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

export async function listClusterDeployments(cluster: string): Promise<DeploymentInfo[]> {
  try {
    return await listAllDeployments(cluster);
  } catch {
    const namespaces = (await listNamespaces(cluster).catch(() => [])).filter(
      (ns) => !SYSTEM_NAMESPACES.has(ns)
    );
    const batches = await Promise.all(
      namespaces.map((ns) => listDeployments(cluster, ns).catch(() => []))
    );
    return batches.flat();
  }
}

export async function scaleDeployment(
  cluster: string,
  namespace: string,
  name: string,
  replicas: number
): Promise<DeploymentInfo> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.AppsV1Api);

  const patch = [{ op: 'replace', path: '/spec/replicas', value: replicas }];

  const patched = await api.patchNamespacedDeployment(
    name,
    namespace,
    patch,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH } }
  );

  const dep = patched.body;
  return {
    name: dep.metadata?.name ?? name,
    namespace: dep.metadata?.namespace ?? namespace,
    cluster,
    replicas: dep.status?.replicas ?? 0,
    readyReplicas: dep.status?.readyReplicas ?? 0,
    availableReplicas: dep.status?.availableReplicas ?? 0,
    desiredReplicas: dep.spec?.replicas ?? replicas,
    labels: dep.metadata?.labels ?? {},
    matchLabels: dep.spec?.selector?.matchLabels ?? {},
    createdAt: dep.metadata?.creationTimestamp?.toISOString() ?? null,
  };
}

export async function listPods(
  cluster: string,
  namespace: string,
  deploymentName?: string,
  labelSelector?: string
): Promise<PodInfo[]> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.CoreV1Api);

  const selector = labelSelector ?? (deploymentName ? `app=${deploymentName}` : undefined);

  const res = await api.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    selector
  );

  return (res.body.items ?? []).map((pod) => {
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const readyCount = containerStatuses.filter((c) => c.ready).length;
    const total = containerStatuses.length;
    const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
    const created = pod.metadata?.creationTimestamp;

    let age = 'unknown';
    if (created) {
      const diffMs = Date.now() - new Date(created).getTime();
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 60) age = `${diffMin}m`;
      else if (diffMin < 1440) age = `${Math.floor(diffMin / 60)}h`;
      else age = `${Math.floor(diffMin / 1440)}d`;
    }

    return {
      name: pod.metadata?.name ?? 'unknown',
      namespace: pod.metadata?.namespace ?? namespace,
      status: pod.status?.phase ?? 'Unknown',
      ready: `${readyCount}/${total}`,
      restarts,
      age,
      nodeName: pod.spec?.nodeName ?? null,
    };
  });
}

export async function getDeployment(
  cluster: string,
  namespace: string,
  name: string
): Promise<DeploymentInfo | null> {
  const deployments = await listDeployments(cluster, namespace);
  return deployments.find((d) => d.name === name) ?? null;
}

export interface DeploymentResources {
  cpuCores: number;
  memoryGb: number;
}

function sumContainerResources(containers: k8s.V1Container[] | undefined): DeploymentResources {
  let cpuCores = 0;
  let memoryGb = 0;
  for (const c of containers ?? []) {
    const req = c.resources?.requests;
    cpuCores += parseCpuQuantity(req?.cpu);
    memoryGb += parseMemoryGiQuantity(req?.memory);
  }
  return { cpuCores, memoryGb };
}

function parseCpuQuantity(quantity?: string | number): number {
  if (quantity === undefined || quantity === null) return 0;
  const s = String(quantity);
  if (s.endsWith('m')) return Number(s.slice(0, -1)) / 1000;
  return Number(s) || 0;
}

function parseMemoryGiQuantity(quantity?: string | number): number {
  if (quantity === undefined || quantity === null) return 0;
  const s = String(quantity);
  const value = Number(s.replace(/[a-zA-Z]+$/, '')) || 0;
  if (s.endsWith('Ki')) return value / (1024 * 1024);
  if (s.endsWith('Mi')) return value / 1024;
  if (s.endsWith('Gi')) return value;
  if (s.endsWith('Ti')) return value * 1024;
  return value / 1024 ** 3;
}

export async function getDeploymentResources(
  cluster: string,
  namespace: string,
  name: string
): Promise<DeploymentResources> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.AppsV1Api);
  const res = await api.readNamespacedDeployment(name, namespace);
  return sumContainerResources(res.body.spec?.template?.spec?.containers);
}

export interface InstanceTypeCount {
  instanceType: string;
  capacityType: 'spot' | 'on-demand';
  count: number;
}

export async function listClusterInstanceTypes(cluster: string): Promise<InstanceTypeCount[]> {
  const { detectCapacityType } = await import('./instance-pricing');
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.CoreV1Api);
  const res = await api.listNode();
  const counts = new Map<string, number>();

  for (const node of res.body.items ?? []) {
    const labels = node.metadata?.labels ?? {};
    const type =
      labels['node.kubernetes.io/instance-type'] ??
      labels['beta.kubernetes.io/instance-type'] ??
      labels['eks.amazonaws.com/nodegroup'] ??
      'unknown';
    const capacityType = detectCapacityType(labels);
    const key = `${type}::${capacityType}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([key, count]) => {
      const sep = key.indexOf('::');
      return {
        instanceType: key.slice(0, sep),
        capacityType: key.slice(sep + 2) as 'spot' | 'on-demand',
        count,
      };
    })
    .sort((a, b) => b.count - a.count);
}

export async function getWorkloadDesiredReplicas(
  cluster: string,
  namespace: string,
  kind: WorkloadKind,
  name: string
): Promise<number> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.AppsV1Api);

  if (kind === 'Deployment') {
    const res = await api.readNamespacedDeployment(name, namespace);
    return res.body.spec?.replicas ?? 0;
  }

  if (kind === 'StatefulSet') {
    const res = await api.readNamespacedStatefulSet(name, namespace);
    return res.body.spec?.replicas ?? 0;
  }

  return 0;
}

export async function scaleStatefulSet(
  cluster: string,
  namespace: string,
  name: string,
  replicas: number
): Promise<void> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.AppsV1Api);
  const patch = [{ op: 'replace', path: '/spec/replicas', value: replicas }];

  await api.patchNamespacedStatefulSet(
    name,
    namespace,
    patch,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH } }
  );
}

export async function scaleWorkload(
  cluster: string,
  namespace: string,
  kind: WorkloadKind,
  name: string,
  replicas: number
): Promise<void> {
  if (kind === 'DaemonSet') {
    throw new Error(`DaemonSet "${name}" cannot be scaled — exclude it from namespace schedules`);
  }
  if (kind === 'StatefulSet') {
    await scaleStatefulSet(cluster, namespace, name, replicas);
    return;
  }
  await scaleDeployment(cluster, namespace, name, replicas);
}
