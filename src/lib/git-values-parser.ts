import { parse as parseYaml } from 'yaml';
import type { ResourceFieldSnapshot } from './resource-audit-types';
import { REPLICAS_CONTAINER_MARKER } from './resource-audit-types';
import type { ResourceAuditType } from './resource-audit-types';

function readPath(obj: unknown, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pushIfPresent(
  snapshots: ResourceFieldSnapshot[],
  argocdApp: string,
  namespace: string,
  workload: string,
  containerName: string,
  resourceType: ResourceAuditType,
  raw: unknown
) {
  if (raw == null) return;
  snapshots.push({
    argocdApp,
    namespace,
    workload,
    containerName,
    resourceType,
    value: String(raw),
  });
}

function snapshotsFromResourcesBlock(
  argocdApp: string,
  namespace: string,
  workload: string,
  containerName: string,
  resources: unknown
): ResourceFieldSnapshot[] {
  const snapshots: ResourceFieldSnapshot[] = [];
  pushIfPresent(
    snapshots,
    argocdApp,
    namespace,
    workload,
    containerName,
    'CPU_REQUEST',
    readPath(resources, ['requests', 'cpu'])
  );
  pushIfPresent(
    snapshots,
    argocdApp,
    namespace,
    workload,
    containerName,
    'CPU_LIMIT',
    readPath(resources, ['limits', 'cpu'])
  );
  pushIfPresent(
    snapshots,
    argocdApp,
    namespace,
    workload,
    containerName,
    'MEMORY_REQUEST',
    readPath(resources, ['requests', 'memory'])
  );
  pushIfPresent(
    snapshots,
    argocdApp,
    namespace,
    workload,
    containerName,
    'MEMORY_LIMIT',
    readPath(resources, ['limits', 'memory'])
  );
  return snapshots;
}

export function extractHelmValueSnapshots(
  argocdApp: string,
  filePath: string,
  content: string
): ResourceFieldSnapshot[] {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];

  const snapshots: ResourceFieldSnapshot[] = [];
  const namespace = 'default';
  const baseName = filePath.split('/').pop()?.replace(/\.(ya?ml)$/i, '') ?? 'values';

  const replicaCount = readPath(doc, ['replicaCount']);
  if (typeof replicaCount === 'number' || typeof replicaCount === 'string') {
    snapshots.push({
      argocdApp,
      namespace,
      workload: baseName,
      containerName: REPLICAS_CONTAINER_MARKER,
      resourceType: 'REPLICAS',
      value: String(replicaCount),
    });
  }

  const topResources = readPath(doc, ['resources']);
  snapshots.push(
    ...snapshotsFromResourcesBlock(argocdApp, namespace, baseName, 'main', topResources)
  );

  const autoscalingMin = readPath(doc, ['autoscaling', 'minReplicas']);
  if (typeof autoscalingMin === 'number' || typeof autoscalingMin === 'string') {
    snapshots.push({
      argocdApp,
      namespace,
      workload: baseName,
      containerName: REPLICAS_CONTAINER_MARKER,
      resourceType: 'REPLICAS',
      value: String(autoscalingMin),
    });
  }

  const skipChildKeys = new Set([
    'resources',
    'replicaCount',
    'replicas',
    'autoscaling',
    'image',
    'service',
    'ingress',
    'nodeSelector',
    'tolerations',
    'affinity',
    'nameOverride',
    'fullnameOverride',
    'labels',
    'annotations',
    'podAnnotations',
    'podSecurityContext',
    'securityContext',
    'serviceAccount',
    'volumes',
    'volumeMounts',
    'env',
    'envFrom',
  ]);

  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (skipChildKeys.has(key) || key === baseName) continue;
    if (!value || typeof value !== 'object') continue;
    const child = value as Record<string, unknown>;
    const childReplica = child.replicaCount ?? child.replicas;
    if (typeof childReplica === 'number' || typeof childReplica === 'string') {
      snapshots.push({
        argocdApp,
        namespace,
        workload: key,
        containerName: REPLICAS_CONTAINER_MARKER,
        resourceType: 'REPLICAS',
        value: String(childReplica),
      });
    }
    snapshots.push(
      ...snapshotsFromResourcesBlock(
        argocdApp,
        namespace,
        key,
        'main',
        child.resources ?? readPath(child, ['container', 'resources'])
      )
    );
  }

  return snapshots;
}
