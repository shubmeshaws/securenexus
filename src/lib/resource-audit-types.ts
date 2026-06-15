export const RESOURCE_AUDIT_TYPES = [
  'CPU_REQUEST',
  'CPU_LIMIT',
  'MEMORY_REQUEST',
  'MEMORY_LIMIT',
  'REPLICAS',
  'GIT_SYNC',
] as const;

export type ResourceAuditType = (typeof RESOURCE_AUDIT_TYPES)[number];

export const REPLICAS_CONTAINER_MARKER = '__replicas__';

export const RESOURCE_TYPE_LABELS: Record<ResourceAuditType, string> = {
  CPU_REQUEST: 'CPU Request',
  CPU_LIMIT: 'CPU Limit',
  MEMORY_REQUEST: 'Memory Request',
  MEMORY_LIMIT: 'Memory Limit',
  REPLICAS: 'Replicas',
  GIT_SYNC: 'App up',
};

export const GIT_SYNC_CONTAINER_MARKER = '__git_sync__';
export const GIT_SYNC_WORKLOAD_MARKER = '*';

export interface ResourceFieldSnapshot {
  argocdApp: string;
  namespace: string;
  workload: string;
  containerName: string;
  resourceType: ResourceAuditType;
  value: string;
}

export interface ResourceChangeInput {
  argocdApp: string;
  cluster: string;
  environment: string;
  namespace: string;
  workload: string;
  containerName: string;
  resourceType: ResourceAuditType;
  oldValue: string;
  newValue: string;
  revisionSha: string;
  branchName: string | null;
  podCount: number | null;
  authorName: string;
  authorEmail: string | null;
  commitMessage: string | null;
  syncedAt: Date;
  estimatedCostImpactPerDay: number | null;
}

/** Short commit SHA for display (ArgoCD-style, 7 chars). */
export function shortRevisionSha(sha: string): string {
  if (!sha || sha === 'unknown') return sha;
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export interface ParsedAuthor {
  authorName: string;
  authorEmail: string | null;
}

/** Parse ArgoCD author string: "Name <email@domain.com>" */
export function parseArgoCDAuthor(author: string): ParsedAuthor {
  const trimmed = author.trim();
  const match = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { authorName: match[1].trim(), authorEmail: match[2].trim() };
  }
  return { authorName: trimmed, authorEmail: null };
}
