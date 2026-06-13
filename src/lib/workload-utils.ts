export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

export type ScheduleScope = 'workload' | 'namespace';

export const NAMESPACE_SCOPE_MARKER = '*';

export function workloadKey(kind: string, name: string): string {
  return `${kind}::${name}`;
}

export function parseWorkloadKey(value: string): { kind: WorkloadKind; name: string } | null {
  const sep = value.indexOf('::');
  if (sep <= 0) return null;
  const kind = value.slice(0, sep) as WorkloadKind;
  const name = value.slice(sep + 2);
  if (!name || !['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)) return null;
  return { kind, name };
}

export function isNamespaceSchedule(schedule: {
  scope?: string | null;
  appName?: string | null;
}): boolean {
  return schedule.scope === 'namespace' || schedule.appName === NAMESPACE_SCOPE_MARKER;
}

export function formatWorkloadKeyLabel(key: string): string {
  const parsed = parseWorkloadKey(key);
  return parsed ? `${parsed.name} (${parsed.kind})` : key;
}

export function scheduleTargetLabel(schedule: {
  scope?: string | null;
  appName?: string | null;
  excludedWorkloads?: string[] | null;
}): string {
  if (!isNamespaceSchedule(schedule)) return schedule.appName ?? '—';
  const excluded = schedule.excludedWorkloads?.length ?? 0;
  return excluded > 0 ? `All workloads (${excluded} excluded)` : 'All workloads';
}
