import type { ResourceAuditType } from './resource-audit-types';
import { RESOURCE_TYPE_LABELS } from './resource-audit-types';
import { isBillableResourceType } from './resource-audit-diff';
import { formatUsd } from './utils';
import { auditRowGroupKey, resourceWorkloadLabelFromRow } from './helm-values-path';

const MERGEABLE_TYPES = new Set<ResourceAuditType>([
  'CPU_REQUEST',
  'CPU_LIMIT',
  'MEMORY_REQUEST',
  'MEMORY_LIMIT',
]);

export interface ResourceChangeDetail {
  resourceType: ResourceAuditType;
  oldValue: string;
  newValue: string;
  estimatedCostImpactPerDay: number | null;
}

export interface ResourceAuditRowBase {
  id: string;
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
  syncedAt: string;
  estimatedCostImpactPerDay: number | null;
  changes?: ResourceChangeDetail[];
}

function mergeGroupKey(row: ResourceAuditRowBase): string | null {
  if (row.resourceType === 'GIT_SYNC') return null;
  if (MERGEABLE_TYPES.has(row.resourceType)) {
    return `res:${auditRowGroupKey(row)}`;
  }
  return `single:${row.id}`;
}

function dedupeChanges(changes: ResourceChangeDetail[]): ResourceChangeDetail[] {
  const byType = new Map<ResourceAuditType, ResourceChangeDetail>();
  for (const change of changes) {
    byType.set(change.resourceType, change);
  }
  return Array.from(byType.values());
}

function shortTypeLabel(type: ResourceAuditType | string | undefined): string {
  if (!type) return 'Resource';
  switch (type) {
    case 'CPU_REQUEST':
      return 'CPU req';
    case 'CPU_LIMIT':
      return 'CPU lim';
    case 'MEMORY_REQUEST':
      return 'Mem req';
    case 'MEMORY_LIMIT':
      return 'Mem lim';
    default:
      return (RESOURCE_TYPE_LABELS as Record<string, string>)[type] ?? type;
  }
}

/** One row per app + commit (+ workload) for CPU/memory request & limit changes. */
export function groupResourceAuditRows<T extends ResourceAuditRowBase>(rows: T[]): T[] {
  const order: string[] = [];
  const groups = new Map<string, T>();

  for (const row of rows) {
    const key = mergeGroupKey(row);
    if (!key) {
      order.push(`row:${row.id}`);
      groups.set(`row:${row.id}`, { ...row, changes: undefined });
      continue;
    }

    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, { ...row, changes: [] });
    }

    const group = groups.get(key)!;
    if (!group.changes) group.changes = [];

    if (MERGEABLE_TYPES.has(row.resourceType)) {
      group.changes.push({
        resourceType: row.resourceType,
        oldValue: row.oldValue,
        newValue: row.newValue,
        estimatedCostImpactPerDay: row.estimatedCostImpactPerDay,
      });
      group.estimatedCostImpactPerDay = sumCosts([
        group.estimatedCostImpactPerDay,
        isBillableResourceType(row.resourceType) ? row.estimatedCostImpactPerDay : null,
      ]);
    }
  }

  return order
    .map((key) => groups.get(key)!)
    .filter(Boolean)
    .map((row) => {
      const changes = row.changes?.length ? dedupeChanges(row.changes) : row.changes;
      return {
        ...row,
        changes,
        resourceType: changes?.length ? changes[0].resourceType : row.resourceType,
        estimatedCostImpactPerDay: changes?.length
          ? sumCosts(changes.map(billableChangeCost))
          : isBillableResourceType(row.resourceType)
            ? row.estimatedCostImpactPerDay
            : null,
      };
    });
}

function sumCosts(values: (number | null | undefined)[]): number | null {
  let total = 0;
  let has = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    total += v;
    has = true;
  }
  return has ? total : null;
}

function billableChangeCost(change: ResourceChangeDetail): number | null {
  if (!isBillableResourceType(change.resourceType)) return null;
  return change.estimatedCostImpactPerDay != null ? Number(change.estimatedCostImpactPerDay) : null;
}

export function sumGroupedRowsCostImpact(rows: ResourceAuditRowBase[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.resourceType === 'GIT_SYNC') continue;
    if (row.changes?.length) {
      const grouped = sumCosts(row.changes.map(billableChangeCost));
      if (grouped != null && Number.isFinite(grouped)) total += grouped;
      continue;
    }
    if (!isBillableResourceType(row.resourceType)) continue;
    const cost =
      row.estimatedCostImpactPerDay != null ? Number(row.estimatedCostImpactPerDay) : null;
    if (cost != null && Number.isFinite(cost)) {
      total += cost;
    }
  }
  return total;
}

export function formatGroupedResourceLabel(row: ResourceAuditRowBase): string {
  if (row.resourceType === 'GIT_SYNC') {
    return row.estimatedCostImpactPerDay != null && row.estimatedCostImpactPerDay > 0
      ? 'App up'
      : 'Git sync';
  }

  const changes = row.changes?.length ? row.changes : [row as unknown as ResourceChangeDetail];
  const types = new Set(changes.map((c) => c.resourceType));

  const workload = resourceWorkloadLabelFromRow(row);

  const parts: string[] = [];
  const hasCpu = types.has('CPU_REQUEST') || types.has('CPU_LIMIT');
  const hasMem = types.has('MEMORY_REQUEST') || types.has('MEMORY_LIMIT');

  if (hasCpu) {
    const cpuParts: string[] = [];
    if (types.has('CPU_REQUEST')) cpuParts.push('Request');
    if (types.has('CPU_LIMIT')) cpuParts.push('Limit');
    parts.push(`CPU · ${cpuParts.join(' & ')}`);
  }
  if (hasMem) {
    const memParts: string[] = [];
    if (types.has('MEMORY_REQUEST')) memParts.push('Request');
    if (types.has('MEMORY_LIMIT')) memParts.push('Limit');
    parts.push(`Memory · ${memParts.join(' & ')}`);
  }
  if (types.has('REPLICAS')) parts.push('Replicas');

  const resource = parts.length ? parts.join(', ') : 'Resources';
  return workload ? `${workload} · ${resource}` : resource;
}

export interface ResourceChangeLine {
  label: string;
  oldValue: string;
  newValue: string;
}

export function getResourceChangeLines(row: ResourceAuditRowBase): ResourceChangeLine[] {
  if (row.resourceType === 'GIT_SYNC') return [];

  const changes: ResourceChangeDetail[] = row.changes?.length
    ? row.changes
    : [
        {
          resourceType: row.resourceType,
          oldValue: row.oldValue,
          newValue: row.newValue,
          estimatedCostImpactPerDay: row.estimatedCostImpactPerDay,
        },
      ];

  return changes
    .map((c) => ({
      label: shortTypeLabel(c.resourceType),
      oldValue: normalize(c.oldValue),
      newValue: normalize(c.newValue),
    }))
    .filter((c) => c.oldValue !== c.newValue && (c.oldValue !== '—' || c.newValue !== '—'));
}

export function hasMultipleResourceChanges(row: ResourceAuditRowBase): boolean {
  return getResourceChangeLines(row).length > 1;
}

export function formatGroupedOldNewLines(row: ResourceAuditRowBase): string[] {
  return getResourceChangeLines(row).map(
    (c) => `${c.label}  ${c.oldValue} → ${c.newValue}`
  );
}

function normalize(value: string | null | undefined): string {
  if (value == null) return '—';
  const v = value.trim();
  if (!v || v.toLowerCase() === 'none' || v === '(none)' || v === '—') return '—';
  return v;
}

export function formatGroupedCostCategories(row: ResourceAuditRowBase): string {
  const changes = row.changes?.length ? row.changes : [];
  const cats = new Set<string>();
  for (const c of changes) {
    if (c.resourceType === 'CPU_REQUEST') cats.add('CPU req');
    if (c.resourceType === 'MEMORY_REQUEST') cats.add('Mem req');
    if (c.resourceType === 'REPLICAS') cats.add('Pods');
  }
  return Array.from(cats).join(' & ');
}

export function formatGroupedCostDisplay(row: ResourceAuditRowBase): string {
  const cost =
    row.estimatedCostImpactPerDay != null ? Number(row.estimatedCostImpactPerDay) : null;
  if (cost == null || !Number.isFinite(cost)) return '—';
  const sign = cost > 0 ? '+' : '';
  const cats = formatGroupedCostCategories(row);
  const amount = `${sign}${formatUsd(Math.abs(cost))}/day`;
  return cats ? `${amount} · ${cats}` : amount;
}
