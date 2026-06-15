import type { ResourceChangeAudit } from '@prisma/client';
import {
  groupResourceAuditRows,
  formatGroupedOldNewLines,
  formatGroupedResourceLabel,
} from './resource-audit-grouping';
import { formatTimestampIST } from './utils';

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function resourceLabel(row: ReturnType<typeof groupResourceAuditRows>[number]): string {
  return formatGroupedResourceLabel(row);
}

export function resourceAuditToCsv(rows: ResourceChangeAudit[]): string {
  const headers = [
    'Git Sync Time',
    'Cluster',
    'Environment',
    'Namespace',
    'ArgoCD App',
    'Branch',
    'Commit SHA',
    'Workload',
    'Resource',
    'Old → New',
    'Author',
    'Author Email',
    'Git Comment',
    'Cost Impact / Day (USD)',
  ];

  const grouped = groupResourceAuditRows(
    rows.map((row) => ({
      id: row.id,
      argocdApp: row.argocdApp,
      cluster: row.cluster,
      environment: row.environment,
      namespace: row.namespace,
      workload: row.workload,
      containerName: row.containerName,
      resourceType: row.resourceType as import('./resource-audit-types').ResourceAuditType,
      oldValue: row.oldValue,
      newValue: row.newValue,
      revisionSha: row.revisionSha,
      branchName: row.branchName,
      podCount: row.podCount,
      authorName: row.authorName,
      authorEmail: row.authorEmail,
      commitMessage: row.commitMessage,
      syncedAt: row.syncedAt.toISOString(),
      estimatedCostImpactPerDay:
        row.estimatedCostImpactPerDay != null ? Number(row.estimatedCostImpactPerDay) : null,
    }))
  );

  const lines = grouped.map((row) =>
    [
      formatTimestampIST(row.syncedAt),
      row.cluster,
      row.environment,
      row.namespace,
      row.argocdApp,
      row.branchName ?? '',
      row.revisionSha,
      row.workload,
      resourceLabel(row),
      formatGroupedOldNewLines(row).join(' | '),
      row.authorName,
      row.authorEmail ?? '',
      row.commitMessage ?? '',
      row.estimatedCostImpactPerDay != null ? String(row.estimatedCostImpactPerDay) : '',
    ]
      .map((v) => escapeCsv(String(v)))
      .join(',')
  );

  return [headers.join(','), ...lines].join('\n');
}
