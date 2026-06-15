import type { ResourceAuditFilters } from './resource-audit-service';
import type { ResourceAuditType } from './resource-audit-types';
import { RESOURCE_AUDIT_TYPES } from './resource-audit-types';

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseResourceTypes(value: unknown): ResourceAuditType[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  const matched = parts.filter((p): p is ResourceAuditType =>
    (RESOURCE_AUDIT_TYPES as readonly string[]).includes(p)
  );
  return matched.length ? matched : undefined;
}

export function parseResourceAuditFilters(query: Record<string, unknown>): ResourceAuditFilters {
  return {
    cluster: typeof query.cluster === 'string' ? query.cluster : undefined,
    namespace: typeof query.namespace === 'string' ? query.namespace : undefined,
    argocdApp: typeof query.argocdApp === 'string' ? query.argocdApp : undefined,
    environment: typeof query.environment === 'string' ? query.environment : undefined,
    author: typeof query.author === 'string' ? query.author : undefined,
    fromDate: parseDate(query.fromDate),
    toDate: parseDate(query.toDate),
    resourceTypes: parseResourceTypes(query.resourceType),
    page: parseInt(String(query.page ?? '1'), 10) || 1,
    pageSize: parseInt(String(query.pageSize ?? '10'), 10) || 10,
  };
}
