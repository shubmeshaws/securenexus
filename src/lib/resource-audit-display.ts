import type { ResourceAuditType } from './resource-audit-types';
import { REPLICAS_CONTAINER_MARKER, RESOURCE_TYPE_LABELS } from './resource-audit-types';
import { parseCpuToCores, parseMemoryToGiB } from './resource-quantity';
import { formatUsd } from './utils';

export interface ResourceAuditRowDisplay {
  resourceType: ResourceAuditType;
  containerName: string;
  workload: string;
  oldValue: string;
  newValue: string;
  estimatedCostImpactPerDay: number | null;
}

function normalizeDisplayValue(value: string): string {
  const v = value.trim();
  if (!v || v.toLowerCase() === 'none' || v === '(none)' || v === '—') return '—';
  return v;
}

export function isGitSyncResourceType(type: ResourceAuditType): boolean {
  return type === 'GIT_SYNC';
}

/** Human label: "CPU · Request", "Memory · Limit", "Replicas", etc. */
export function formatResourceChangeLabel(row: ResourceAuditRowDisplay): string {
  if (row.resourceType === 'GIT_SYNC') {
    return row.estimatedCostImpactPerDay != null && row.estimatedCostImpactPerDay > 0
      ? 'App up'
      : 'Git sync';
  }
  if (row.resourceType === 'REPLICAS') return 'Replicas · Pod count';

  const label = RESOURCE_TYPE_LABELS[row.resourceType] ?? row.resourceType;
  const [kind, scope] = label.split(' ');
  const base = kind && scope ? `${kind} · ${scope}` : label;

  const workload =
    row.workload && row.workload !== '*' && row.workload !== 'base' && row.workload !== 'global'
      ? row.workload
      : null;

  if (workload) return `${workload} · ${base}`;
  if (row.containerName !== REPLICAS_CONTAINER_MARKER && row.containerName !== '__git_sync__') {
    return `${row.containerName} · ${base}`;
  }
  return base;
}

export function formatResourceOldNew(row: ResourceAuditRowDisplay): {
  old: string;
  new: string;
  showDiff: boolean;
  isCommitTransition: boolean;
} {
  if (row.resourceType === 'GIT_SYNC') {
    return {
      old: '—',
      new: '—',
      showDiff: false,
      isCommitTransition: false,
    };
  }

  const old = normalizeDisplayValue(row.oldValue);
  const newVal = normalizeDisplayValue(row.newValue);
  const showDiff = old !== newVal && (old !== '—' || newVal !== '—');

  return {
    old,
    new: newVal,
    showDiff,
    isCommitTransition: false,
  };
}

export function costCategoryForResourceType(type: ResourceAuditType): 'CPU' | 'Memory' | 'Pods' | null {
  if (type === 'CPU_REQUEST' || type === 'CPU_LIMIT') return 'CPU';
  if (type === 'MEMORY_REQUEST' || type === 'MEMORY_LIMIT') return 'Memory';
  if (type === 'REPLICAS') return 'Pods';
  return null;
}

export function formatResourceCostDisplay(row: ResourceAuditRowDisplay): string {
  const cost =
    row.estimatedCostImpactPerDay != null
      ? Number(row.estimatedCostImpactPerDay)
      : null;
  if (row.resourceType === 'GIT_SYNC') {
    if (cost == null || !Number.isFinite(cost)) return '—';
    return `${formatUsd(cost)}/day · Running`;
  }
  if (cost == null || !Number.isFinite(cost)) return '—';

  const category = costCategoryForResourceType(row.resourceType);
  const sign = cost > 0 ? '+' : '';
  const amount = `${sign}${formatUsd(cost)}/day`;
  return category ? `${amount} · ${category}` : amount;
}

export function isResourceIncrease(
  resourceType: ResourceAuditType,
  oldValue: string,
  newValue: string
): boolean {
  if (resourceType === 'GIT_SYNC') return false;

  if (resourceType === 'REPLICAS') {
    const oldR = parseInt(oldValue, 10) || 0;
    const newR = parseInt(newValue, 10) || 0;
    return newR > oldR;
  }

  if (resourceType === 'CPU_REQUEST' || resourceType === 'CPU_LIMIT') {
    return parseCpuToCores(newValue) > parseCpuToCores(oldValue);
  }

  if (resourceType === 'MEMORY_REQUEST' || resourceType === 'MEMORY_LIMIT') {
    return parseMemoryToGiB(newValue) > parseMemoryToGiB(oldValue);
  }

  return false;
}

export function formatContributorActivity(stats: {
  commits?: number;
  resourceIncreases?: number;
  resourceChanges?: number;
}): string {
  const commits = stats.commits ?? 0;
  const resourceIncreases = stats.resourceIncreases ?? stats.resourceChanges ?? 0;
  const parts: string[] = [];
  if (commits > 0) {
    parts.push(`${commits} commit${commits !== 1 ? 's' : ''}`);
  }
  if (resourceIncreases > 0) {
    parts.push(
      `${resourceIncreases} resource increase${resourceIncreases !== 1 ? 's' : ''}`
    );
  }
  return parts.length ? parts.join(' · ') : 'No activity in range';
}

export function formatFilterDateRangeLabel(fromDate: string, toDate: string): string {
  if (!fromDate && !toDate) return 'All time';

  const fmt = (dateStr: string) => {
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  if (fromDate && toDate) {
    const from = new Date(`${fromDate}T12:00:00`);
    const to = new Date(`${toDate}T12:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'filtered range';
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
    return `${fmt(fromDate)} – ${fmt(toDate)} (${days}d)`;
  }
  if (fromDate) return `From ${fmt(fromDate)}`;
  return `Until ${fmt(toDate)}`;
}
