import type { ResourceAuditType } from './resource-audit-types';
import { REPLICAS_CONTAINER_MARKER } from './resource-audit-types';
import type { ResourceFieldSnapshot } from './resource-audit-types';

interface K8sContainer {
  name?: string;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

interface K8sWorkloadSpec {
  replicas?: number;
  template?: { spec?: { containers?: K8sContainer[] } };
  containers?: K8sContainer[];
}

interface K8sWorkload {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: K8sWorkloadSpec;
}

const TRACKED_KINDS = new Set(['Deployment', 'StatefulSet']);

function fieldValue(
  container: K8sContainer,
  resourceType: ResourceAuditType
): string | null {
  const resources = container.resources;
  switch (resourceType) {
    case 'CPU_REQUEST':
      return resources?.requests?.cpu ?? null;
    case 'CPU_LIMIT':
      return resources?.limits?.cpu ?? null;
    case 'MEMORY_REQUEST':
      return resources?.requests?.memory ?? null;
    case 'MEMORY_LIMIT':
      return resources?.limits?.memory ?? null;
    default:
      return null;
  }
}

export function extractResourceSnapshots(
  argocdApp: string,
  liveStateJson: string,
  kind: string,
  namespace: string,
  workloadName: string
): ResourceFieldSnapshot[] {
  if (!TRACKED_KINDS.has(kind) || !liveStateJson) return [];

  let parsed: K8sWorkload;
  try {
    parsed = JSON.parse(liveStateJson) as K8sWorkload;
  } catch {
    return [];
  }

  const ns = parsed.metadata?.namespace ?? namespace;
  const name = parsed.metadata?.name ?? workloadName;
  const replicas = parsed.spec?.replicas;
  const containers =
    parsed.spec?.template?.spec?.containers ?? parsed.spec?.containers ?? [];

  const snapshots: ResourceFieldSnapshot[] = [];

  if (typeof replicas === 'number') {
    snapshots.push({
      argocdApp,
      namespace: ns,
      workload: name,
      containerName: REPLICAS_CONTAINER_MARKER,
      resourceType: 'REPLICAS',
      value: String(replicas),
    });
  }

  for (const container of containers) {
    const containerName = container.name ?? 'unknown';
    for (const resourceType of [
      'CPU_REQUEST',
      'CPU_LIMIT',
      'MEMORY_REQUEST',
      'MEMORY_LIMIT',
    ] as ResourceAuditType[]) {
      const value = fieldValue(container, resourceType);
      if (value != null) {
        snapshots.push({
          argocdApp,
          namespace: ns,
          workload: name,
          containerName,
          resourceType,
          value,
        });
      }
    }
  }

  return snapshots;
}

export function snapshotKey(row: {
  argocdApp: string;
  namespace: string;
  workload: string;
  containerName: string;
  resourceType: string;
}): string {
  return `${row.argocdApp}::${row.namespace}::${row.workload}::${row.containerName}::${row.resourceType}`;
}
