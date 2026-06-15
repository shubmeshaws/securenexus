import { parse as parseYaml, parseAllDocuments } from 'yaml';
import type { ResourceFieldSnapshot } from './resource-audit-types';
import { REPLICAS_CONTAINER_MARKER } from './resource-audit-types';
import type { ResourceAuditType } from './resource-audit-types';

interface K8sContainer {
  name?: string;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

interface K8sWorkloadDoc {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: K8sContainer[] } };
    containers?: K8sContainer[];
  };
}

const TRACKED_KINDS = new Set(['Deployment', 'StatefulSet']);

function fieldValue(container: K8sContainer, resourceType: ResourceAuditType): string | null {
  const resources = container.resources;
  let raw: string | number | undefined;
  switch (resourceType) {
    case 'CPU_REQUEST':
      raw = resources?.requests?.cpu as string | number | undefined;
      break;
    case 'CPU_LIMIT':
      raw = resources?.limits?.cpu as string | number | undefined;
      break;
    case 'MEMORY_REQUEST':
      raw = resources?.requests?.memory as string | number | undefined;
      break;
    case 'MEMORY_LIMIT':
      raw = resources?.limits?.memory as string | number | undefined;
      break;
    default:
      return null;
  }
  if (raw == null) return null;
  return String(raw);
}

function snapshotsFromWorkload(
  argocdApp: string,
  doc: K8sWorkloadDoc | null | undefined
): ResourceFieldSnapshot[] {
  if (!doc || typeof doc !== 'object') return [];
  const kind = doc.kind ?? '';
  if (!TRACKED_KINDS.has(kind)) return [];

  const ns = doc.metadata?.namespace ?? 'default';
  const name = doc.metadata?.name ?? 'unknown';
  const replicas = doc.spec?.replicas;
  const containers = doc.spec?.template?.spec?.containers ?? doc.spec?.containers ?? [];
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
          value: String(value),
        });
      }
    }
  }

  return snapshots;
}

function parseManifestDocument(raw: string): K8sWorkloadDoc | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as K8sWorkloadDoc;
  } catch {
    try {
      return parseYaml(trimmed) as K8sWorkloadDoc;
    } catch {
      return null;
    }
  }
}

export function extractSnapshotsFromManifests(
  argocdApp: string,
  manifests: string[],
  namespaceFilter?: string
): ResourceFieldSnapshot[] {
  const snapshots: ResourceFieldSnapshot[] = [];

  for (const raw of manifests) {
    let docs: K8sWorkloadDoc[] = [];
    try {
      docs = parseAllDocuments(raw)
        .map((d) => d.toJSON() as K8sWorkloadDoc | null)
        .filter((doc): doc is K8sWorkloadDoc => doc != null && typeof doc === 'object');
    } catch {
      const single = parseManifestDocument(raw);
      if (single) docs = [single];
    }

    for (const doc of docs) {
      snapshots.push(...snapshotsFromWorkload(argocdApp, doc));
    }
  }

  if (!namespaceFilter) return snapshots;
  return snapshots.filter((s) => s.namespace === namespaceFilter);
}
