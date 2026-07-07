import prisma from './prisma';
import { getSecurityScanJobDelegate } from './prisma-security-scan-job';
import { assertSecurityModuleEnabled } from './security-service';
import { runSecurityScans } from './security-service';
import { getSecurityToolById, resolveScanPairs } from './security-tools';
import type { ScanProgressCallback } from './security-scan-progress';

import type { SecurityScanJobStatus, SecurityScanJobView, SecurityReportMode } from './security-scan-types';

export type { SecurityScanJobStatus, SecurityScanJobView } from './security-scan-types';

const runningJobIds = new Set<string>();
const lastProgressPersist = new Map<string, number>();

function scanJobs() {
  return getSecurityScanJobDelegate() as typeof prisma.securityScanJob;
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

async function resolveJobLabels(resourceIds: string[], toolIds: string[]): Promise<{
  resourceNames: string[];
  toolNames: string[];
}> {
  const resources = resourceIds.length
    ? await prisma.securityResource.findMany({
        where: { id: { in: resourceIds } },
        select: { id: true, name: true },
      })
    : [];
  const resourceNameById = new Map(resources.map((row) => [row.id, row.name]));
  return {
    resourceNames: resourceIds.map((id) => resourceNameById.get(id) ?? id),
    toolNames: toolIds.map((id) => getSecurityToolById(id)?.name ?? id),
  };
}

async function toScanJobView(row: {
  id: string;
  resourceIds: unknown;
  toolIds: unknown;
  status: string;
  progress: number;
  message: string | null;
  error: string | null;
  reportCount: number;
  pairTotal: number;
  reportMode?: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): Promise<SecurityScanJobView> {
  const resourceIds = parseIdList(row.resourceIds);
  const toolIds = parseIdList(row.toolIds);
  const { resourceNames, toolNames } = await resolveJobLabels(resourceIds, toolIds);
  return {
    id: row.id,
    resourceIds,
    toolIds,
    resourceNames,
    toolNames,
    status: row.status as SecurityScanJobStatus,
    progress: row.progress,
    message: row.message,
    error: row.error,
    reportCount: row.reportCount,
    pairTotal: row.pairTotal,
    reportMode: (row.reportMode === 'merged' ? 'merged' : 'separate') as SecurityReportMode,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function persistJobProgress(jobId: string, progress: number, message: string): Promise<void> {
  const now = Date.now();
  const last = lastProgressPersist.get(jobId) ?? 0;
  if (progress < 100 && now - last < 750) return;
  lastProgressPersist.set(jobId, now);

  await scanJobs().update({
    where: { id: jobId },
    data: {
      progress: Math.min(100, Math.max(0, progress)),
      message,
    },
  });
}

export async function createSecurityScanJob(input: {
  resourceIds: string[];
  toolIds: string[];
  reportMode?: SecurityReportMode;
  createdBy?: string | null;
}): Promise<SecurityScanJobView> {
  await assertSecurityModuleEnabled();
  if (!input.resourceIds.length) throw new Error('Select at least one target');
  if (!input.toolIds.length) throw new Error('Select at least one tool');

  const toolSettings = await prisma.securityToolSetting.findMany();
  const enabledIds = new Set(toolSettings.filter((row) => row.enabled).map((row) => row.toolId));
  const resources = await prisma.securityResource.findMany({
    where: { id: { in: input.resourceIds } },
    select: { id: true, type: true },
  });

  const pairs = resolveScanPairs({
    resources: resources.map((row) => ({
      id: row.id,
      type: row.type as 'repository' | 'target_url',
    })),
    toolIds: input.toolIds,
    enabledToolIds: enabledIds,
  });
  if (pairs.length === 0) {
    throw new Error('No valid target and tool combinations for this scan');
  }

  const row = await scanJobs().create({
    data: {
      resourceIds: input.resourceIds,
      toolIds: input.toolIds,
      status: 'queued',
      progress: 0,
      message: 'Queued…',
      pairTotal: pairs.length,
      reportMode: input.reportMode ?? 'separate',
      createdBy: input.createdBy ?? null,
    },
  });

  return toScanJobView(row);
}

export async function getSecurityScanJob(id: string): Promise<SecurityScanJobView | null> {
  await assertSecurityModuleEnabled();
  const row = await scanJobs().findUnique({ where: { id } });
  if (!row) return null;
  return toScanJobView(row);
}

export async function listSecurityScanJobs(limit = 20): Promise<SecurityScanJobView[]> {
  await assertSecurityModuleEnabled();
  const rows = await scanJobs().findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  if (!rows.length) return [];

  const allResourceIds = Array.from(
    new Set(rows.flatMap((row) => parseIdList(row.resourceIds)))
  );
  const resources = allResourceIds.length
    ? await prisma.securityResource.findMany({
        where: { id: { in: allResourceIds } },
        select: { id: true, name: true },
      })
    : [];
  const resourceNameById = new Map(resources.map((row) => [row.id, row.name]));

  return rows.map((row) => {
    const resourceIds = parseIdList(row.resourceIds);
    const toolIds = parseIdList(row.toolIds);
    return {
      id: row.id,
      resourceIds,
      toolIds,
      resourceNames: resourceIds.map((id) => resourceNameById.get(id) ?? id),
      toolNames: toolIds.map((id) => getSecurityToolById(id)?.name ?? id),
      status: row.status as SecurityScanJobStatus,
      progress: row.progress,
      message: row.message,
      error: row.error,
      reportCount: row.reportCount,
      pairTotal: row.pairTotal,
      reportMode: (row.reportMode === 'merged' ? 'merged' : 'separate') as SecurityReportMode,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  });
}

export async function getActiveSecurityScanJob(): Promise<SecurityScanJobView | null> {
  await assertSecurityModuleEnabled();
  const row = await scanJobs().findFirst({
    where: { status: { in: ['queued', 'running'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return toScanJobView(row);
}

export async function deleteSecurityScanJob(id: string): Promise<void> {
  await assertSecurityModuleEnabled();
  const row = await scanJobs().findUnique({ where: { id } });
  if (!row) throw new Error('Scan job not found');
  if (row.status === 'running' || row.status === 'queued') {
    throw new Error('Cannot delete a scan that is still in progress');
  }
  await scanJobs().delete({ where: { id } });
}

export async function executeSecurityScanJob(jobId: string): Promise<void> {
  if (runningJobIds.has(jobId)) return;

  const job = await scanJobs().findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === 'completed' || job.status === 'failed') return;

  runningJobIds.add(jobId);
  lastProgressPersist.delete(jobId);

  const resourceIds = parseIdList(job.resourceIds);
  const toolIds = parseIdList(job.toolIds);

  try {
    await scanJobs().update({
      where: { id: jobId },
      data: {
        status: 'running',
        startedAt: job.startedAt ?? new Date(),
        message: 'Starting scan…',
        progress: 1,
        error: null,
      },
    });

    const onProgress: ScanProgressCallback = (update) => {
      void persistJobProgress(jobId, update.progress, update.message);
    };

    const reports = await runSecurityScans(
      { resourceIds, toolIds },
      onProgress,
      { scanJobId: jobId, reportMode: (job.reportMode === 'merged' ? 'merged' : 'separate') }
    );

    await scanJobs().update({
      where: { id: jobId },
      data: {
        status: 'completed',
        progress: 100,
        message: 'All scans completed',
        reportCount: reports.length,
        completedAt: new Date(),
        error: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scan failed';
    await scanJobs().update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error: message,
        message: 'Scan failed',
        completedAt: new Date(),
      },
    });
  } finally {
    runningJobIds.delete(jobId);
    lastProgressPersist.delete(jobId);
  }
}

export function startSecurityScanJobAsync(jobId: string): void {
  void executeSecurityScanJob(jobId);
}

export async function rerunSecurityScanJob(jobId: string): Promise<SecurityScanJobView> {
  await assertSecurityModuleEnabled();
  const active = await getActiveSecurityScanJob();
  if (active) throw new Error('A scan is already in progress');

  const existing = await scanJobs().findUnique({ where: { id: jobId } });
  if (!existing) throw new Error('Scan job not found');

  const job = await createSecurityScanJob({
    resourceIds: parseIdList(existing.resourceIds),
    toolIds: parseIdList(existing.toolIds),
    reportMode: existing.reportMode === 'merged' ? 'merged' : 'separate',
    createdBy: existing.createdBy,
  });
  startSecurityScanJobAsync(job.id);
  return job;
}
