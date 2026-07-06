import { msToHours } from './cost-calendar';

export type StoppedEventKind = 'stop' | 'start';

const STOP_ACTIONS = new Set([
  'schedule-shutdown',
  'infra-shutdown',
  'scale-down',
]);

const START_ACTIONS = new Set([
  'schedule-startup',
  'infra-startup',
  'scale-up',
]);

export interface StoppedTimeLog {
  action: string;
  cluster: string;
  namespace: string;
  appName: string;
  status: string;
  details: string | null;
  timestamp: Date;
}

interface MsInterval {
  start: number;
  end: number;
}

export function classifyStoppedEvent(action: string): StoppedEventKind | null {
  if (STOP_ACTIONS.has(action)) return 'stop';
  if (START_ACTIONS.has(action)) return 'start';
  return null;
}

export function parseLogDetails(details: string | null): {
  platformType?: string;
  instanceId?: string;
  region?: string;
} {
  if (!details) return {};
  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    return {
      platformType: typeof parsed.platformType === 'string' ? parsed.platformType : undefined,
      instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined,
      region: typeof parsed.region === 'string' ? parsed.region : undefined,
    };
  } catch {
    return {};
  }
}

export function isNonEksActivityLog(log: Pick<StoppedTimeLog, 'details'>): boolean {
  return parseLogDetails(log.details).platformType === 'non_eks';
}

function mergeIntervals(intervals: MsInterval[]): MsInterval[] {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: MsInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function sumIntervalMs(intervals: MsInterval[], now: Date): number {
  const nowMs = now.getTime();
  return intervals.reduce((sum, interval) => {
    const end = Math.min(interval.end, nowMs);
    return sum + Math.max(0, end - interval.start);
  }, 0);
}

function clipIntervalMs(
  interval: MsInterval,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date
): number {
  const effectiveEnd = Math.min(interval.end, rangeEnd.getTime(), now.getTime());
  const effectiveStart = Math.max(interval.start, rangeStart.getTime());
  return Math.max(0, effectiveEnd - effectiveStart);
}

function sumIntervalMsInRange(
  intervals: MsInterval[],
  rangeStart: Date,
  rangeEnd: Date,
  now: Date
): number {
  return mergeIntervals(intervals).reduce(
    (sum, interval) => sum + clipIntervalMs(interval, rangeStart, rangeEnd, now),
    0
  );
}

/** Build stop→start intervals for one resource key from chronological logs. */
export function buildStoppedIntervalsForLogs(
  logs: StoppedTimeLog[],
  now: Date
): MsInterval[] {
  const sorted = [...logs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let openAt: Date | null = null;
  const closed: MsInterval[] = [];

  for (const log of sorted) {
    if (log.status !== 'success') continue;
    const kind = classifyStoppedEvent(log.action);
    if (!kind) continue;

    if (kind === 'stop') {
      // Already stopped: keep the original stop timestamp (do not reset).
      if (!openAt) openAt = log.timestamp;
    } else if (openAt) {
      const endMs = log.timestamp.getTime();
      const startMs = openAt.getTime();
      if (endMs > startMs) {
        closed.push({ start: startMs, end: endMs });
      }
      openAt = null;
    }
  }

  if (openAt) {
    closed.push({ start: openAt.getTime(), end: now.getTime() });
  }

  return closed;
}

function eksResourceKey(log: StoppedTimeLog): string | null {
  if (isNonEksActivityLog(log)) return null;
  if (!log.cluster?.trim() || !log.namespace?.trim()) return null;
  const namespaceScope = log.appName === '*' || !log.appName?.trim();
  if (namespaceScope) return `${log.cluster}::${log.namespace}`;
  return `${log.cluster}::${log.namespace}::${log.appName}`;
}

function namespaceKeyFromResourceKey(resourceKey: string): string {
  const parts = resourceKey.split('::');
  return `${parts[0]}::${parts[1]}`;
}

function ec2ResourceKey(log: StoppedTimeLog): string | null {
  if (!isNonEksActivityLog(log)) return null;
  const details = parseLogDetails(log.details);
  return details.instanceId ?? log.appName ?? null;
}

export interface NamespaceStoppedStat {
  cluster: string;
  namespace: string;
  stoppedMs: number;
  stoppedHours: number;
}

export interface StandaloneStoppedStat {
  instanceName: string;
  instanceId: string;
  instanceType: string;
  stoppedMs: number;
  stoppedHours: number;
}

export interface StoppedIntervalRow {
  cluster: string;
  namespace: string;
  start: Date;
  end: Date;
}

export interface Ec2StoppedIntervalRow {
  cluster: string;
  instanceId: string;
  instanceType: string;
  start: Date;
  end: Date;
}

function intervalsToRows(
  cluster: string,
  namespace: string,
  intervals: MsInterval[]
): StoppedIntervalRow[] {
  return intervals.map((interval) => ({
    cluster,
    namespace,
    start: new Date(interval.start),
    end: new Date(interval.end),
  }));
}

export function computeEksNamespaceStoppedIntervals(
  logs: StoppedTimeLog[],
  now: Date
): StoppedIntervalRow[] {
  const eksLogs = logs.filter((log) => !isNonEksActivityLog(log));
  const resourceKeys = new Set<string>();
  for (const log of eksLogs) {
    const key = eksResourceKey(log);
    if (key) resourceKeys.add(key);
  }

  const intervalsByNamespace = new Map<string, MsInterval[]>();

  for (const resourceKey of Array.from(resourceKeys)) {
    const resourceLogs = eksLogs.filter((log) => eksResourceKey(log) === resourceKey);
    const intervals = buildStoppedIntervalsForLogs(resourceLogs, now);
    if (!intervals.length) continue;

    const namespaceKey = namespaceKeyFromResourceKey(resourceKey);
    const existing = intervalsByNamespace.get(namespaceKey) ?? [];
    intervalsByNamespace.set(namespaceKey, existing.concat(intervals));
  }

  const rows: StoppedIntervalRow[] = [];
  for (const [key, intervals] of Array.from(intervalsByNamespace.entries())) {
    const sep = key.indexOf('::');
    const cluster = key.slice(0, sep);
    const namespace = key.slice(sep + 2);
    rows.push(...intervalsToRows(cluster, namespace, mergeIntervals(intervals)));
  }
  return rows;
}

export function computeEc2StoppedIntervals(
  logs: StoppedTimeLog[],
  now: Date,
  instanceMeta: Map<string, { name: string; instanceType: string }>
): Ec2StoppedIntervalRow[] {
  const ec2Logs = logs.filter((log) => isNonEksActivityLog(log));
  const instanceIds = new Set<string>();
  for (const log of ec2Logs) {
    const key = ec2ResourceKey(log);
    if (key) instanceIds.add(key);
  }

  const clusterByInstance = new Map<string, string>();
  for (const log of ec2Logs) {
    const key = ec2ResourceKey(log);
    if (key && log.cluster?.trim()) {
      clusterByInstance.set(key, log.cluster);
    }
  }

  const rows: Ec2StoppedIntervalRow[] = [];
  for (const instanceId of Array.from(instanceIds)) {
    const resourceLogs = ec2Logs.filter((log) => ec2ResourceKey(log) === instanceId);
    const intervals = buildStoppedIntervalsForLogs(resourceLogs, now);
    const meta = instanceMeta.get(instanceId);
    const cluster = clusterByInstance.get(instanceId) ?? 'standalone-ec2';
    const instanceType = meta?.instanceType ?? 'unknown';
    for (const interval of intervals) {
      rows.push({
        cluster,
        instanceId,
        instanceType,
        start: new Date(interval.start),
        end: new Date(interval.end),
      });
    }
  }
  return rows;
}

export function computeEksNamespaceStoppedStats(
  logs: StoppedTimeLog[],
  now: Date,
  range?: { start: Date; end: Date }
): NamespaceStoppedStat[] {
  const eksLogs = logs.filter((log) => !isNonEksActivityLog(log));
  const resourceKeys = new Set<string>();
  for (const log of eksLogs) {
    const key = eksResourceKey(log);
    if (key) resourceKeys.add(key);
  }

  const intervalsByNamespace = new Map<string, MsInterval[]>();

  for (const resourceKey of Array.from(resourceKeys)) {
    const resourceLogs = eksLogs.filter((log) => eksResourceKey(log) === resourceKey);
    const intervals = buildStoppedIntervalsForLogs(resourceLogs, now);
    if (!intervals.length) continue;

    const namespaceKey = namespaceKeyFromResourceKey(resourceKey);
    const existing = intervalsByNamespace.get(namespaceKey) ?? [];
    intervalsByNamespace.set(namespaceKey, existing.concat(intervals));
  }

  return Array.from(intervalsByNamespace.entries())
    .map(([key, intervals]) => {
      const sep = key.indexOf('::');
      const merged = mergeIntervals(intervals);
      const stoppedMs = range
        ? sumIntervalMsInRange(merged, range.start, range.end, now)
        : sumIntervalMs(merged, now);
      return {
        cluster: key.slice(0, sep),
        namespace: key.slice(sep + 2),
        stoppedMs,
        stoppedHours: msToHours(stoppedMs),
      };
    })
    .filter((row) => row.stoppedMs > 0)
    .sort((a, b) => b.stoppedMs - a.stoppedMs);
}

export function computeStandaloneStoppedStats(
  logs: StoppedTimeLog[],
  now: Date,
  instanceMeta: Map<string, { name: string; instanceType: string }>,
  range?: { start: Date; end: Date }
): StandaloneStoppedStat[] {
  const ec2Logs = logs.filter((log) => isNonEksActivityLog(log));
  const instanceIds = new Set<string>();
  for (const log of ec2Logs) {
    const key = ec2ResourceKey(log);
    if (key) instanceIds.add(key);
  }

  const displayNames = new Map<string, string>();
  for (const log of ec2Logs) {
    const key = ec2ResourceKey(log);
    if (!key) continue;
    const candidate = log.appName?.trim();
    if (!candidate) continue;
    const existing = displayNames.get(key);
    if (!existing || existing === key) {
      displayNames.set(key, candidate);
    }
  }

  return Array.from(instanceIds)
    .map((instanceId) => {
      const resourceLogs = ec2Logs.filter((log) => ec2ResourceKey(log) === instanceId);
      const intervals = buildStoppedIntervalsForLogs(resourceLogs, now);
      const stoppedMs = range
        ? sumIntervalMsInRange(intervals, range.start, range.end, now)
        : sumIntervalMs(intervals, now);
      const meta = instanceMeta.get(instanceId);
      const fallbackName = displayNames.get(instanceId);
      const instanceName =
        (meta?.name && meta.name !== instanceId ? meta.name : null) ??
        (fallbackName && fallbackName !== instanceId ? fallbackName : null) ??
        instanceId;
      return {
        instanceId,
        instanceName,
        instanceType: meta?.instanceType ?? 'unknown',
        stoppedMs,
        stoppedHours: msToHours(stoppedMs),
      };
    })
    .filter((row) => row.stoppedMs > 0)
    .sort((a, b) => b.stoppedMs - a.stoppedMs);
}
