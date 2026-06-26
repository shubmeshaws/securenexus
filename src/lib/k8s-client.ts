import * as k8s from '@kubernetes/client-node';
import prisma from '@/lib/prisma';
import { readKubeconfigFromPath } from '@/lib/kubeconfig-file';
import { buildEksKubeConfigForRegisteredCluster } from '@/lib/eks-kubeconfig';
import { withRetry } from '@/lib/concurrency';

/** Extract the HTTP status code from a Kubernetes client error, if present. */
function k8sStatusCode(err: unknown): number | undefined {
  return (
    (err as { statusCode?: number })?.statusCode ??
    (err as { body?: { code?: number } })?.body?.code
  );
}

function isK8sNotFoundError(err: unknown): boolean {
  return k8sStatusCode(err) === 404;
}

/**
 * Retry a Kubernetes read that is used to resolve Argo CD tracking metadata.
 * Transient failures (timeouts, 5xx, throttling) spike when many schedules run
 * at once; silently returning null then drops the Argo deny window. Retry those,
 * but never retry a genuine 404 (resource really doesn't exist).
 */
const K8S_ARGO_LOOKUP_ATTEMPTS = (() => {
  const v = Number(process.env.K8S_ARGO_LOOKUP_ATTEMPTS);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 8) : 4;
})();

function retryK8sArgoLookup<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    attempts: K8S_ARGO_LOOKUP_ATTEMPTS,
    baseDelayMs: 1500,
    maxDelayMs: 12000,
    shouldRetry: (err) => k8sStatusCode(err) !== 404,
    onRetry: (err, attempt, delayMs) =>
      console.warn(
        `[k8s retry] ${label} attempt ${attempt} failed (${
          err instanceof Error ? err.message : err
        }); retrying in ${delayMs}ms`
      ),
  });
}
export interface ClusterInfo {
  name: string;
  context: string;
  server: string;
  current: boolean;
}

export type WorkloadKind =
  | 'Deployment'
  | 'StatefulSet'
  | 'DaemonSet'
  | 'CronJob'
  | 'ScaledJob'
  | 'ScaledObject';

/** KEDA annotation that pauses/resumes ScaledJobs (KEDA >= 2.8). */
const KEDA_PAUSED_ANNOTATION = 'autoscaling.keda.sh/paused';
const KEDA_PAUSED_REPLICAS_ANNOTATION = 'autoscaling.keda.sh/paused-replicas';

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

const kubeConfigCache = new Map<string, { at: number; config: k8s.KubeConfig }>();
const KUBECONFIG_CACHE_TTL_MS = 10 * 60_000;

export function invalidateKubeConfigCache() {
  registeredClustersCache = null;
  kubeConfigCache.clear();
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
  const cached = kubeConfigCache.get(clusterName);
  if (cached && Date.now() - cached.at < KUBECONFIG_CACHE_TTL_MS) {
    return cached.config;
  }

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
  const config =
    fromAwsIntegration ??
    (registeredB64
      ? loadKubeConfigFromBase64(registeredB64, registered.contextName ?? clusterName)
      : null);

  if (!config) {
    throw new Error(`Cluster "${clusterName}" has no kubeconfig stored. Re-add the cluster with a valid kubeconfig.`);
  }

  kubeConfigCache.set(clusterName, { at: Date.now(), config });
  return config;
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
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

  const [deployments, statefulSets, daemonSets, cronJobs, scaledJobsRes, scaledObjectsRes] =
    await Promise.all([
    appsApi.listNamespacedDeployment(namespace).catch(() => ({ body: { items: [] as k8s.V1Deployment[] } })),
    appsApi.listNamespacedStatefulSet(namespace).catch(() => ({ body: { items: [] as k8s.V1StatefulSet[] } })),
    appsApi.listNamespacedDaemonSet(namespace).catch(() => ({ body: { items: [] as k8s.V1DaemonSet[] } })),
    batchApi.listNamespacedCronJob(namespace).catch(() => ({ body: { items: [] as k8s.V1CronJob[] } })),
    customApi
      .listNamespacedCustomObject('keda.sh', 'v1alpha1', namespace, 'scaledjobs')
      .catch(() => null),
    customApi
      .listNamespacedCustomObject('keda.sh', 'v1alpha1', namespace, 'scaledobjects')
      .catch(() => null),
  ]);

  const scaledJobItems =
    (scaledJobsRes?.body as { items?: Array<{ metadata?: { name?: string } }> } | undefined)?.items ??
    [];
  const scaledObjectItems =
    (scaledObjectsRes?.body as { items?: Array<{ metadata?: { name?: string } }> } | undefined)?.items ??
    [];

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
  for (const cj of cronJobs.body.items ?? []) {
    const name = cj.metadata?.name;
    if (name) workloads.push({ name, kind: 'CronJob', namespace, cluster });
  }
  for (const sj of scaledJobItems) {
    const name = sj.metadata?.name;
    if (name) workloads.push({ name, kind: 'ScaledJob', namespace, cluster });
  }
  for (const so of scaledObjectItems) {
    const name = so.metadata?.name;
    if (name) workloads.push({ name, kind: 'ScaledObject', namespace, cluster });
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

  let patched;
  try {
    patched = await api.patchNamespacedDeployment(
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
  } catch (err) {
    if (replicas === 0 && isK8sNotFoundError(err)) {
      return {
        name,
        namespace,
        cluster,
        replicas: 0,
        readyReplicas: 0,
        availableReplicas: 0,
        desiredReplicas: 0,
        labels: {},
        matchLabels: {},
        createdAt: null,
      };
    }
    throw err;
  }

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

/** Ready Kubernetes nodes in a cluster (captured before workload shutdown). */
export async function getClusterReadyNodeCount(cluster: string): Promise<number | null> {
  try {
    const kc = await getConfigForCluster(cluster);
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.listNode();
    let ready = 0;
    for (const node of res.body.items ?? []) {
      const isReady = (node.status?.conditions ?? []).some(
        (condition) => condition.type === 'Ready' && condition.status === 'True'
      );
      if (isReady) ready += 1;
    }
    return ready;
  } catch {
    return null;
  }
}

/** Running pods across all namespaces in a cluster. */
export async function getClusterRunningPodCount(cluster: string): Promise<number | null> {
  try {
    const kc = await getConfigForCluster(cluster);
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.listPodForAllNamespaces();
    let running = 0;
    for (const pod of res.body.items ?? []) {
      if (pod.status?.phase === 'Running') running += 1;
    }
    return running;
  } catch {
    return null;
  }
}

export async function getWorkloadDesiredReplicas(
  cluster: string,
  namespace: string,
  kind: WorkloadKind,
  name: string
): Promise<number> {
  const kc = await getConfigForCluster(cluster);

  if (kind === 'Deployment') {
    try {
      const api = kc.makeApiClient(k8s.AppsV1Api);
      const res = await api.readNamespacedDeployment(name, namespace);
      return res.body.spec?.replicas ?? 0;
    } catch (err) {
      if (isK8sNotFoundError(err)) return 0;
      throw err;
    }
  }

  if (kind === 'StatefulSet') {
    try {
      const api = kc.makeApiClient(k8s.AppsV1Api);
      const res = await api.readNamespacedStatefulSet(name, namespace);
      return res.body.spec?.replicas ?? 0;
    } catch (err) {
      if (isK8sNotFoundError(err)) return 0;
      throw err;
    }
  }

  if (kind === 'CronJob') {
    try {
      const api = kc.makeApiClient(k8s.BatchV1Api);
      const res = await api.readNamespacedCronJob(name, namespace);
      return res.body.spec?.suspend ? 0 : 1;
    } catch (err) {
      if (isK8sNotFoundError(err)) return 0;
      throw err;
    }
  }

  if (kind === 'ScaledJob') {
    const api = kc.makeApiClient(k8s.CustomObjectsApi);
    const res = await api.getNamespacedCustomObject(
      'keda.sh',
      'v1alpha1',
      namespace,
      'scaledjobs',
      name
    );
    const body = res.body as {
      metadata?: { annotations?: Record<string, string> };
    };
    const paused = body.metadata?.annotations?.[KEDA_PAUSED_ANNOTATION];
    return paused === 'true' ? 0 : 1;
  }

  if (kind === 'ScaledObject') {
    try {
      const body = await readScaledObjectBody(cluster, namespace, name);
      const target = getScaledObjectScaleTargetFromBody(body);
      if (!target) return 0;
      return getWorkloadDesiredReplicas(cluster, namespace, target.kind, target.name);
    } catch (err) {
      const status = (err as { statusCode?: number; body?: { code?: number } })?.statusCode
        ?? (err as { body?: { code?: number } })?.body?.code;
      if (status === 404) return 0;
      throw err;
    }
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

  try {
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
  } catch (err) {
    if (replicas === 0 && isK8sNotFoundError(err)) return;
    throw err;
  }
}

export async function statefulSetExists(
  cluster: string,
  namespace: string,
  name: string
): Promise<boolean> {
  try {
    const kc = await getConfigForCluster(cluster);
    const api = kc.makeApiClient(k8s.AppsV1Api);
    await api.readNamespacedStatefulSet(name, namespace);
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number; body?: { code?: number } })?.statusCode
      ?? (err as { body?: { code?: number } })?.body?.code;
    if (status === 404) return false;
    throw err;
  }
}

type ObjectMeta = { labels?: { [k: string]: string }; annotations?: { [k: string]: string } } | undefined;

/**
 * Extract the owning ArgoCD application name from a resource's tracking metadata.
 * ArgoCD marks managed resources with the `argocd.argoproj.io/tracking-id`
 * annotation (annotation tracking) and/or the `app.kubernetes.io/instance` label
 * (label tracking, default).
 */
function argoAppNameFromMeta(meta: ObjectMeta): string | null {
  // tracking-id format: "<app>:<group>/<kind>:<namespace>/<name>"
  const trackingId = meta?.annotations?.['argocd.argoproj.io/tracking-id'];
  const fromTracking = trackingId?.split(':')[0]?.trim();
  if (fromTracking) return fromTracking;

  const instanceLabel = meta?.labels?.['app.kubernetes.io/instance']?.trim();
  if (instanceLabel) return instanceLabel;

  return null;
}

/**
 * Read the ArgoCD application managing a StatefulSet directly from the live
 * resource. Far more reliable than matching apps by namespace, since one Argo app
 * often deploys resources across namespaces under a name unrelated to the workload.
 */
export async function getStatefulSetArgoAppName(
  cluster: string,
  namespace: string,
  name: string
): Promise<string | null> {
  try {
    return await retryK8sArgoLookup(`statefulset ${namespace}/${name}`, async () => {
      const kc = await getConfigForCluster(cluster);
      const api = kc.makeApiClient(k8s.AppsV1Api);
      const res = await api.readNamespacedStatefulSet(name, namespace);
      return argoAppNameFromMeta(res.body.metadata);
    });
  } catch {
    return null;
  }
}

/** Read the Argo CD application managing a Deployment from live tracking metadata. */
export async function getDeploymentArgoAppName(
  cluster: string,
  namespace: string,
  name: string
): Promise<string | null> {
  try {
    return await retryK8sArgoLookup(`deployment ${namespace}/${name}`, async () => {
      const kc = await getConfigForCluster(cluster);
      const api = kc.makeApiClient(k8s.AppsV1Api);
      const res = await api.readNamespacedDeployment(name, namespace);
      return argoAppNameFromMeta(res.body.metadata);
    });
  } catch {
    return null;
  }
}

/** Read the Argo CD application managing a CronJob from live tracking metadata. */
export async function getCronJobArgoAppName(
  cluster: string,
  namespace: string,
  name: string
): Promise<string | null> {
  try {
    return await retryK8sArgoLookup(`cronjob ${namespace}/${name}`, async () => {
      const kc = await getConfigForCluster(cluster);
      const api = kc.makeApiClient(k8s.BatchV1Api);
      const res = await api.readNamespacedCronJob(name, namespace);
      return argoAppNameFromMeta(res.body.metadata);
    });
  } catch {
    return null;
  }
}

/**
 * Collect the set of ArgoCD application names managing workloads in a namespace,
 * derived from each live resource's tracking metadata. Covers Deployments and
 * StatefulSets — enough to identify the Argo apps that need pausing for a
 * namespace-scoped shutdown.
 */
export async function getArgoAppNamesForNamespace(
  cluster: string,
  namespace: string
): Promise<string[]> {
  const names = new Set<string>();
  try {
    const kc = await getConfigForCluster(cluster);
    const api = kc.makeApiClient(k8s.AppsV1Api);

    const [deployments, statefulSets] = await Promise.all([
      retryK8sArgoLookup(`list deployments ${namespace}`, () =>
        api.listNamespacedDeployment(namespace)
      ).catch(() => null),
      retryK8sArgoLookup(`list statefulsets ${namespace}`, () =>
        api.listNamespacedStatefulSet(namespace)
      ).catch(() => null),
    ]);

    for (const item of deployments?.body.items ?? []) {
      const app = argoAppNameFromMeta(item.metadata);
      if (app) names.add(app);
    }
    for (const item of statefulSets?.body.items ?? []) {
      const app = argoAppNameFromMeta(item.metadata);
      if (app) names.add(app);
    }
  } catch {
    // best-effort
  }
  return Array.from(names);
}

function labelSelectorFromMatchLabels(matchLabels?: { [key: string]: string }): string | undefined {
  if (!matchLabels) return undefined;
  const entries = Object.entries(matchLabels);
  if (!entries.length) return undefined;
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

function podBelongsToStatefulSet(pod: k8s.V1Pod, stsName: string): boolean {
  const owned = (pod.metadata?.ownerReferences ?? []).some(
    (owner) => owner.kind === 'StatefulSet' && owner.name === stsName
  );
  if (owned) return true;
  // StatefulSet pods are named "<sts>-<ordinal>"; match as a fallback once GC
  // has stripped the ownerReference.
  const podName = pod.metadata?.name ?? '';
  return new RegExp(`^${stsName}-\\d+$`).test(podName);
}

/**
 * Delete a StatefulSet while preserving its PVCs. PVCs created from
 * volumeClaimTemplates are not owned by the StatefulSet, so deletion removes the
 * pods but leaves persistent storage intact — no data loss. After deleting the
 * StatefulSet we explicitly delete its pods so none linger.
 */
export async function deleteStatefulSet(
  cluster: string,
  namespace: string,
  name: string
): Promise<void> {
  const kc = await getConfigForCluster(cluster);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  // Capture the pod selector before deleting so we can clean up pods afterwards.
  let labelSelector: string | undefined;
  try {
    const sts = await appsApi.readNamespacedStatefulSet(name, namespace);
    labelSelector = labelSelectorFromMatchLabels(sts.body.spec?.selector?.matchLabels);
  } catch (err) {
    const status = (err as { statusCode?: number; body?: { code?: number } })?.statusCode
      ?? (err as { body?: { code?: number } })?.body?.code;
    if (status === 404) return;
    throw err;
  }

  // Delete the StatefulSet (Background cascade removes the object immediately;
  // the garbage collector removes owned pods asynchronously).
  await appsApi.deleteNamespacedStatefulSet(
    name,
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    'Background'
  );

  // Belt-and-suspenders: explicitly delete any pods still belonging to the STS
  // so none linger if GC is slow.
  try {
    const pods = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );
    for (const pod of pods.body.items ?? []) {
      if (!podBelongsToStatefulSet(pod, name)) continue;
      const podName = pod.metadata?.name;
      if (!podName) continue;
      try {
        await coreApi.deleteNamespacedPod(podName, namespace);
      } catch {
        // Pod may already be terminating from the cascade delete.
      }
    }
  } catch {
    // Pod cleanup is best-effort; the cascade delete already removes them.
  }
}

async function setCronJobSuspended(
  cluster: string,
  namespace: string,
  name: string,
  suspend: boolean
): Promise<void> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.BatchV1Api);

  await api.patchNamespacedCronJob(
    name,
    namespace,
    { spec: { suspend } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } }
  );

  const verify = await api.readNamespacedCronJob(name, namespace);
  const actual = verify.body.spec?.suspend ?? false;
  if (actual !== suspend) {
    throw new Error(
      `Failed to ${suspend ? 'suspend' : 'resume'} CronJob "${name}" (spec.suspend is still ${actual})`
    );
  }
}

function cronJobOwnsJob(cronJobName: string, job: k8s.V1Job): boolean {
  const owners = job.metadata?.ownerReferences ?? [];
  if (owners.some((owner) => owner.kind === 'CronJob' && owner.name === cronJobName)) {
    return true;
  }
  const labelName = job.metadata?.labels?.['cronjob.kubernetes.io/name'];
  return labelName === cronJobName;
}

/** Remove Jobs owned by a CronJob so scheduled pods stop running. */
async function deleteActiveCronJobJobs(
  cluster: string,
  namespace: string,
  cronJobName: string
): Promise<number> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.BatchV1Api);
  const res = await api.listNamespacedJob(namespace);
  let deleted = 0;

  for (const job of res.body.items ?? []) {
    if (!cronJobOwnsJob(cronJobName, job)) continue;

    const jobName = job.metadata?.name;
    if (!jobName) continue;

    try {
      await api.deleteNamespacedJob(
        jobName,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'Foreground'
      );
      deleted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'delete failed';
      throw new Error(`Failed to delete Job "${jobName}" for CronJob "${cronJobName}": ${message}`);
    }
  }

  return deleted;
}

async function suspendCronJob(
  cluster: string,
  namespace: string,
  name: string
): Promise<void> {
  await setCronJobSuspended(cluster, namespace, name, true);
  await deleteActiveCronJobJobs(cluster, namespace, name);
}

/** Pause/resume a KEDA ScaledJob via the official annotation (stops the scale loop). */
async function setScaledJobPaused(
  cluster: string,
  namespace: string,
  name: string,
  paused: boolean
): Promise<void> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.CustomObjectsApi);

  const body = {
    metadata: {
      annotations: { [KEDA_PAUSED_ANNOTATION]: paused ? 'true' : 'false' },
    },
  };

  await api.patchNamespacedCustomObject(
    'keda.sh',
    'v1alpha1',
    namespace,
    'scaledjobs',
    name,
    body,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } }
  );

  const verify = await api.getNamespacedCustomObject(
    'keda.sh',
    'v1alpha1',
    namespace,
    'scaledjobs',
    name
  );
  const verifyBody = verify.body as {
    metadata?: { annotations?: Record<string, string> };
  };
  const actual = verifyBody.metadata?.annotations?.[KEDA_PAUSED_ANNOTATION];
  const expected = paused ? 'true' : 'false';
  if (actual !== expected) {
    throw new Error(
      `Failed to ${paused ? 'pause' : 'resume'} ScaledJob "${name}" (${KEDA_PAUSED_ANNOTATION} is "${actual ?? 'unset'}")`
    );
  }
}

function scaledJobOwnsJob(scaledJobName: string, job: k8s.V1Job): boolean {
  const owners = job.metadata?.ownerReferences ?? [];
  if (owners.some((owner) => owner.kind === 'ScaledJob' && owner.name === scaledJobName)) {
    return true;
  }
  return job.metadata?.labels?.['scaledjob.keda.sh/name'] === scaledJobName;
}

/** Remove Jobs owned by a ScaledJob so running pods stop after pausing. */
async function deleteActiveScaledJobJobs(
  cluster: string,
  namespace: string,
  scaledJobName: string
): Promise<number> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.BatchV1Api);
  const res = await api.listNamespacedJob(namespace);
  let deleted = 0;

  for (const job of res.body.items ?? []) {
    if (!scaledJobOwnsJob(scaledJobName, job)) continue;

    const jobName = job.metadata?.name;
    if (!jobName) continue;

    try {
      await api.deleteNamespacedJob(
        jobName,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'Foreground'
      );
      deleted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'delete failed';
      throw new Error(
        `Failed to delete Job "${jobName}" for ScaledJob "${scaledJobName}": ${message}`
      );
    }
  }

  return deleted;
}

async function pauseScaledJob(
  cluster: string,
  namespace: string,
  name: string
): Promise<void> {
  await setScaledJobPaused(cluster, namespace, name, true);
  await deleteActiveScaledJobJobs(cluster, namespace, name);
}

export async function scaledObjectExists(
  cluster: string,
  namespace: string,
  name: string
): Promise<boolean> {
  try {
    await readScaledObjectBody(cluster, namespace, name);
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number; body?: { code?: number } })?.statusCode
      ?? (err as { body?: { code?: number } })?.body?.code;
    if (status === 404) return false;
    throw err;
  }
}

/** Delete a ScaledObject so KEDA releases the scale target; Argo CD recreates it on startup. */
export async function deleteScaledObject(
  cluster: string,
  namespace: string,
  name: string
): Promise<void> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  await api.deleteNamespacedCustomObject(
    'keda.sh',
    'v1alpha1',
    namespace,
    'scaledobjects',
    name
  );
}

/**
 * Stop a ScaledObject by deleting it. With Argo CD paused, the object stays deleted until sync
 * on startup. Without Argo, also scales the underlying Deployment/StatefulSet to 0.
 */
export async function shutdownScaledObject(
  cluster: string,
  namespace: string,
  name: string,
  options: { managedByArgo: boolean; settleBeforeDeleteMs?: number }
): Promise<void> {
  if (!options.managedByArgo) {
    throw new Error(
      `ScaledObject "${name}" delete requires a linked Argo CD app — use pauseScaledObjectByAnnotation instead`
    );
  }

  const scaleTarget = await getScaledObjectScaleTarget(cluster, namespace, name);

  if (options.settleBeforeDeleteMs) {
    await new Promise((resolve) => setTimeout(resolve, options.settleBeforeDeleteMs));
  }

  if (await scaledObjectExists(cluster, namespace, name)) {
    await deleteScaledObject(cluster, namespace, name);
  }

  // Scale target is left running; KEDA recreates autoscaling when Argo restores the SO.
  if (!scaleTarget) {
    console.warn(
      `[ScaledObject shutdown] ${namespace}/${name} deleted but scale target could not be resolved`
    );
  }
}

type ScaledObjectBody = {
  metadata?: { annotations?: Record<string, string> };
  spec?: { scaleTargetRef?: { name?: string; kind?: string } };
};

async function readScaledObjectBody(
  cluster: string,
  namespace: string,
  name: string
): Promise<ScaledObjectBody> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  const res = await api.getNamespacedCustomObject(
    'keda.sh',
    'v1alpha1',
    namespace,
    'scaledobjects',
    name
  );
  return res.body as ScaledObjectBody;
}

function getScaledObjectScaleTargetFromBody(
  body: ScaledObjectBody
): { kind: 'Deployment' | 'StatefulSet'; name: string } | null {
  const ref = body.spec?.scaleTargetRef;
  if (!ref?.name) return null;
  const kind = ref.kind === 'StatefulSet' ? 'StatefulSet' : 'Deployment';
  return { kind, name: ref.name };
}

export async function getScaledObjectScaleTarget(
  cluster: string,
  namespace: string,
  name: string
): Promise<{ kind: 'Deployment' | 'StatefulSet'; name: string } | null> {
  try {
    return await retryK8sArgoLookup(`scaledobject ${namespace}/${name}`, async () => {
      const body = await readScaledObjectBody(cluster, namespace, name);
      return getScaledObjectScaleTargetFromBody(body);
    });
  } catch {
    return null;
  }
}

/** Guess scale target when the ScaledObject was already deleted (name suffix convention). */
export function guessScaledObjectScaleTargetName(scaledObjectName: string): string {
  return scaledObjectName.replace(/-scaledobject$/i, '');
}

async function replaceScaledObjectAnnotations(
  cluster: string,
  namespace: string,
  name: string,
  annotations: Record<string, string>
): Promise<void> {
  const kc = await getConfigForCluster(cluster);
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  const body = await readScaledObjectBody(cluster, namespace, name);
  const hasAnnotations = body.metadata?.annotations != null;
  const patch = hasAnnotations
    ? [{ op: 'replace', path: '/metadata/annotations', value: annotations }]
    : [{ op: 'add', path: '/metadata/annotations', value: annotations }];

  await api.patchNamespacedCustomObject(
    'keda.sh',
    'v1alpha1',
    namespace,
    'scaledobjects',
    name,
    patch,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/json-patch+json' } }
  );
}

/** Fallback stop when no Argo CD app is linked — pause via KEDA annotations. */
export async function pauseScaledObjectByAnnotation(
  cluster: string,
  namespace: string,
  name: string
): Promise<void> {
  const body = await readScaledObjectBody(cluster, namespace, name);
  const next = { ...(body.metadata?.annotations ?? {}) };
  next[KEDA_PAUSED_REPLICAS_ANNOTATION] = '0';
  next[KEDA_PAUSED_ANNOTATION] = 'true';
  await replaceScaledObjectAnnotations(cluster, namespace, name, next);
}

/** Fallback start when no Argo CD app is linked. */
export async function resumeScaledObjectByAnnotation(
  cluster: string,
  namespace: string,
  name: string
): Promise<void> {
  const body = await readScaledObjectBody(cluster, namespace, name);
  const next = { ...(body.metadata?.annotations ?? {}) };
  delete next[KEDA_PAUSED_REPLICAS_ANNOTATION];
  delete next[KEDA_PAUSED_ANNOTATION];
  await replaceScaledObjectAnnotations(cluster, namespace, name, next);
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
  if (kind === 'ScaledObject') {
    throw new Error(
      `ScaledObject "${name}" is stopped via delete and started via Argo CD sync — use shutdownScaledObject instead`
    );
  }
  if (kind === 'CronJob') {
    if (replicas === 0) {
      await suspendCronJob(cluster, namespace, name);
    } else {
      await setCronJobSuspended(cluster, namespace, name, false);
    }
    return;
  }
  if (kind === 'ScaledJob') {
    if (replicas === 0) {
      await pauseScaledJob(cluster, namespace, name);
    } else {
      await setScaledJobPaused(cluster, namespace, name, false);
    }
    return;
  }
  if (kind === 'StatefulSet') {
    await scaleStatefulSet(cluster, namespace, name, replicas);
    return;
  }
  await scaleDeployment(cluster, namespace, name, replicas);
}
