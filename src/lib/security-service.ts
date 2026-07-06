import prisma from './prisma';
import { getSecurityModuleEnabled } from './settings';
import { SECURITY_TOOLS, getSecurityToolById, resolveScanPairs, compatibleToolsForResource } from './security-tools';
import { buildSecurityReportHtml, countFindingsBySeverity, countScaDependenciesBySeverity, sampleFindings, securityReportToPdfBuffer } from './security-report-export';
import { runSemgrepScan } from './security/semgrep-runner';
import { runNpmAuditScan } from './security/npm-audit-runner';
import { runGitleaksScan } from './security/gitleaks-runner';
import {
  getToolRuntimeStatus,
  installToolRuntime,
  isRuntimeSecurityTool,
  type ServerOsType,
} from './security/tool-runtime';

import { emitScanProgress, type ScanProgressCallback } from './security-scan-progress';
import {
  cloneSecurityResourceRepo,
  getSecurityResourceCloneStatus,
  pullSecurityResourceRepo,
  removeSecurityResourceClone,
  type SecurityResourceCloneStatus,
} from './security/security-repo-prep';

export type { ScanProgressCallback, ScanProgressUpdate } from './security-scan-progress';
export type { SecurityResourceCloneStatus } from './security/security-repo-prep';

export type SecurityResourceType = 'repository' | 'target_url';

export interface SecurityResourceView {
  id: string;
  type: SecurityResourceType;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  targetUrl: string | null;
  description: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  clone?: SecurityResourceCloneStatus;
}

export interface SecurityToolSettingView {
  toolId: string;
  enabled: boolean;
  runtimeRequired: boolean;
  runtimeAvailable: boolean;
  runtimeReady: boolean;
  installedAt: string | null;
  installedOs: ServerOsType | null;
  runtimeVersion: string | null;
  installCommands: string[];
}

export interface SecurityReportView {
  id: string;
  resourceId: string | null;
  resourceName: string | null;
  toolId: string;
  toolName: string;
  title: string;
  status: string;
  summary: string | null;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  createdAt: string;
}

export interface SecurityDashboardStats {
  totals: {
    scans: number;
    resources: number;
    enabledResources: number;
    enabledTools: number;
    high: number;
    medium: number;
    low: number;
  };
  bySeverity: { label: string; count: number; color: string }[];
  byTool: {
    toolId: string;
    toolName: string;
    scans: number;
    high: number;
    medium: number;
    low: number;
  }[];
  recentScans: SecurityReportView[];
}

function toResourceView(row: {
  id: string;
  type: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  targetUrl: string | null;
  description: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SecurityResourceView {
  return {
    id: row.id,
    type: row.type as SecurityResourceType,
    name: row.name,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    targetUrl: row.targetUrl,
    description: row.description,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function assertSecurityModuleEnabled(): Promise<void> {
  const enabled = await getSecurityModuleEnabled();
  if (!enabled) {
    throw new Error('Security module is disabled');
  }
}

function parseRepoUrl(repoUrl: string): { name: string } {
  const trimmed = repoUrl.trim().replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  const slug = parts[parts.length - 1]?.replace(/\.git$/i, '') ?? 'repository';
  return { name: slug };
}

async function enrichResourceView(row: Parameters<typeof toResourceView>[0]): Promise<SecurityResourceView> {
  const view = toResourceView(row);
  if (view.type === 'repository') {
    view.clone = await getSecurityResourceCloneStatus(view.id);
  }
  return view;
}

export async function listSecurityResources(): Promise<SecurityResourceView[]> {
  await assertSecurityModuleEnabled();
  const rows = await prisma.securityResource.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(rows.map((row) => enrichResourceView(row)));
}

export async function createSecurityResource(input: {
  type: SecurityResourceType;
  name?: string;
  repoUrl?: string;
  defaultBranch?: string;
  targetUrl?: string;
  description?: string;
  enabled?: boolean;
  createdBy?: string;
}): Promise<SecurityResourceView> {
  await assertSecurityModuleEnabled();

  if (input.type === 'repository') {
    const repoUrl = input.repoUrl?.trim();
    if (!repoUrl) throw new Error('Repository URL is required');
    const parsed = parseRepoUrl(repoUrl);
    const row = await prisma.securityResource.create({
      data: {
        type: 'repository',
        name: input.name?.trim() || parsed.name,
        repoUrl,
        defaultBranch: input.defaultBranch?.trim() || null,
        description: input.description?.trim() || null,
        enabled: input.enabled ?? true,
        createdBy: input.createdBy ?? null,
      },
    });
    return enrichResourceView(row);
  }

  const targetUrl = input.targetUrl?.trim();
  if (!targetUrl) throw new Error('Target URL is required');
  let hostname = targetUrl;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    // keep raw target as display name fallback
  }
  const row = await prisma.securityResource.create({
    data: {
      type: 'target_url',
      name: input.name?.trim() || hostname,
      targetUrl,
      description: input.description?.trim() || null,
      enabled: input.enabled ?? true,
      createdBy: input.createdBy ?? null,
    },
  });
  return enrichResourceView(row);
}

export async function getSecurityResource(id: string): Promise<SecurityResourceView> {
  await assertSecurityModuleEnabled();
  const row = await prisma.securityResource.findUnique({ where: { id } });
  if (!row) throw new Error('Resource not found');
  return enrichResourceView(row);
}

export async function cloneSecurityResource(id: string): Promise<SecurityResourceView> {
  const resource = await getSecurityResource(id);
  await cloneSecurityResourceRepo(resource);
  return getSecurityResource(id);
}

export async function pullSecurityResource(id: string): Promise<SecurityResourceView> {
  const resource = await getSecurityResource(id);
  await pullSecurityResourceRepo(resource);
  return getSecurityResource(id);
}

export type SecurityResourceSyncAction = 'clone' | 'pull';

export type SecurityResourceSyncJobState = {
  running: boolean;
  resourceId: string | null;
  action: SecurityResourceSyncAction | null;
  phase: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: SecurityResourceView | null;
  message: string | null;
  error: string | null;
};

let securityResourceSyncJob: SecurityResourceSyncJobState = {
  running: false,
  resourceId: null,
  action: null,
  phase: null,
  startedAt: null,
  finishedAt: null,
  result: null,
  message: null,
  error: null,
};

export function getSecurityResourceSyncJob(): SecurityResourceSyncJobState {
  return securityResourceSyncJob;
}

export function startSecurityResourceSyncJob(
  resourceId: string,
  action: SecurityResourceSyncAction
): boolean {
  if (securityResourceSyncJob.running) return false;

  securityResourceSyncJob = {
    running: true,
    resourceId,
    action,
    phase: action === 'clone' ? 'Cloning repository…' : 'Pulling latest changes…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    message: null,
    error: null,
  };

  void (async () => {
    try {
      const resource = await getSecurityResource(resourceId);
      if (action === 'clone') {
        securityResourceSyncJob = { ...securityResourceSyncJob, phase: 'Cloning repository…' };
        await cloneSecurityResourceRepo(resource, (phase) => {
          securityResourceSyncJob = { ...securityResourceSyncJob, phase };
        });
      } else {
        securityResourceSyncJob = { ...securityResourceSyncJob, phase: 'Pulling latest changes…' };
        await pullSecurityResourceRepo(resource, (phase) => {
          securityResourceSyncJob = { ...securityResourceSyncJob, phase };
        });
      }
      const updated = await getSecurityResource(resourceId);
      securityResourceSyncJob = {
        ...securityResourceSyncJob,
        running: false,
        finishedAt: new Date().toISOString(),
        phase: action === 'clone' ? 'Clone complete' : 'Pull complete',
        result: updated,
        message:
          action === 'clone'
            ? `Cloned ${updated.name} successfully.`
            : `Pulled latest changes for ${updated.name}.`,
        error: null,
      };
    } catch (err) {
      securityResourceSyncJob = {
        ...securityResourceSyncJob,
        running: false,
        finishedAt: new Date().toISOString(),
        phase: null,
        result: null,
        error: err instanceof Error ? err.message : `${action} failed`,
      };
    }
  })();

  return true;
}

export async function updateSecurityResource(
  id: string,
  input: {
    name?: string;
    repoUrl?: string;
    defaultBranch?: string | null;
    targetUrl?: string;
    description?: string | null;
    enabled?: boolean;
  }
): Promise<SecurityResourceView> {
  await assertSecurityModuleEnabled();
  const existing = await prisma.securityResource.findUnique({ where: { id } });
  if (!existing) throw new Error('Resource not found');

  const row = await prisma.securityResource.update({
    where: { id },
    data: {
      name: input.name?.trim() || undefined,
      repoUrl: input.repoUrl?.trim() || undefined,
      defaultBranch: input.defaultBranch === undefined ? undefined : input.defaultBranch?.trim() || null,
      targetUrl: input.targetUrl?.trim() || undefined,
      description: input.description === undefined ? undefined : input.description?.trim() || null,
      enabled: input.enabled,
    },
  });
  return enrichResourceView(row);
}

export async function deleteSecurityResource(id: string): Promise<void> {
  await assertSecurityModuleEnabled();
  await removeSecurityResourceClone(id);
  await prisma.securityResource.delete({ where: { id } });
}

async function ensureToolSettingsSeeded(): Promise<void> {
  for (const tool of SECURITY_TOOLS) {
    await prisma.securityToolSetting.upsert({
      where: { toolId: tool.id },
      create: { toolId: tool.id, enabled: false },
      update: {},
    });
  }
}

export async function listSecurityToolSettings(): Promise<SecurityToolSettingView[]> {
  await assertSecurityModuleEnabled();
  await ensureToolSettingsSeeded();
  const rows = await prisma.securityToolSetting.findMany();
  const byId = new Map(rows.map((row) => [row.toolId, row]));

  return Promise.all(
    SECURITY_TOOLS.map(async (tool) => {
      const row = byId.get(tool.id);
      const runtime = await getToolRuntimeStatus(
        tool.id,
        row?.installedAt ?? null,
        row?.installedOs ?? null
      );
      return {
        toolId: tool.id,
        enabled: row?.enabled ?? false,
        runtimeRequired: runtime.runtimeRequired,
        runtimeAvailable: runtime.runtimeAvailable,
        runtimeReady: runtime.runtimeReady,
        installedAt: runtime.installedAt,
        installedOs: runtime.installedOs,
        runtimeVersion: runtime.version,
        installCommands: runtime.installCommands,
      };
    })
  );
}

export async function setSecurityToolEnabled(toolId: string, enabled: boolean): Promise<void> {
  await assertSecurityModuleEnabled();
  const tool = getSecurityToolById(toolId);
  if (!tool) throw new Error('Unknown security tool');
  await ensureToolSettingsSeeded();

  if (enabled && isRuntimeSecurityTool(toolId)) {
    const row = await prisma.securityToolSetting.findUnique({ where: { toolId } });
    if (!row?.installedAt) {
      throw new Error(`${tool.name} must be installed on this server before it can be enabled.`);
    }
  }

  await prisma.securityToolSetting.upsert({
    where: { toolId },
    create: { toolId, enabled },
    update: { enabled },
  });
}

export async function installSecurityToolRuntime(
  toolId: string,
  options?: { enableAfter?: boolean; osType?: ServerOsType; onProgress?: (message: string) => void }
): Promise<{
  toolId: string;
  enabled: boolean;
  installedAt: string;
  installedOs: ServerOsType;
  runtimeVersion: string | null;
  message: string;
  tools: SecurityToolSettingView[];
}> {
  await assertSecurityModuleEnabled();
  const tool = getSecurityToolById(toolId);
  if (!tool) throw new Error('Unknown security tool');
  if (!isRuntimeSecurityTool(toolId)) {
    throw new Error(`${tool.name} does not require a server installation step.`);
  }
  if (!options?.osType) {
    throw new Error('Select the server OS type before installing.');
  }

  await ensureToolSettingsSeeded();
  const installResult = await installToolRuntime(toolId, options.osType, options.onProgress);
  const installedAt = new Date();

  await prisma.securityToolSetting.upsert({
    where: { toolId },
    create: {
      toolId,
      enabled: options?.enableAfter ?? true,
      installedAt,
      installedOs: options.osType,
    },
    update: {
      installedAt,
      installedOs: options.osType,
      ...(options?.enableAfter ?? true ? { enabled: true } : {}),
    },
  });

  const tools = await listSecurityToolSettings();
  const updated = tools.find((row) => row.toolId === toolId);

  return {
    toolId,
    enabled: updated?.enabled ?? (options?.enableAfter ?? true),
    installedAt: installedAt.toISOString(),
    installedOs: options.osType,
    runtimeVersion: updated?.runtimeVersion ?? installResult.version,
    message: installResult.message,
    tools,
  };
}

export async function listSecurityReports(): Promise<SecurityReportView[]> {
  await assertSecurityModuleEnabled();
  const rows = await prisma.securityReport.findMany({
    orderBy: { createdAt: 'desc' },
    include: { resource: { select: { name: true } } },
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    resourceId: row.resourceId,
    resourceName: row.resource?.name ?? null,
    toolId: row.toolId,
    toolName: getSecurityToolById(row.toolId)?.name ?? row.toolId,
    title: row.title,
    status: row.status,
    summary: row.summary,
    highCount: row.highCount,
    mediumCount: row.mediumCount,
    lowCount: row.lowCount,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function generateSecurityReport(input: {
  resourceId: string;
  toolId: string;
  scanJobId?: string;
  pairIndex?: number;
  pairTotal?: number;
  onProgress?: ScanProgressCallback;
}): Promise<SecurityReportView> {
  await assertSecurityModuleEnabled();
  const pairIndex = input.pairIndex ?? 0;
  const pairTotal = input.pairTotal ?? 1;
  const stageProgress = (stagePercent: number, message: string) => {
    emitScanProgress(input.onProgress, pairIndex, pairTotal, stagePercent, message, {
      resourceId: input.resourceId,
      toolId: input.toolId,
    });
  };

  stageProgress(2, 'Loading scan configuration…');
  const [resource, toolSetting] = await Promise.all([
    prisma.securityResource.findUnique({ where: { id: input.resourceId } }),
    prisma.securityToolSetting.findUnique({ where: { toolId: input.toolId } }),
  ]);
  if (!resource) throw new Error('Resource not found');
  const tool = getSecurityToolById(input.toolId);
  if (!tool) throw new Error('Unknown security tool');
  if (!toolSetting?.enabled) throw new Error(`${tool.name} is not enabled`);

  const resourceView = toResourceView(resource);
  const title = `${tool.name} scan — ${resourceView.name}`;

  let summary: string;
  let htmlContent: string;
  let highCount: number;
  let mediumCount: number;
  let lowCount: number;

  const runnerProgress = (stagePercent: number, message: string) => {
    stageProgress(stagePercent, message);
  };

  if (tool.id === 'semgrep') {
    stageProgress(5, `Starting Semgrep scan for ${resourceView.name}…`);
    const semgrepResult = await runSemgrepScan({
      resource: resourceView,
      onProgress: runnerProgress,
    });
    summary = semgrepResult.summary;
    htmlContent = semgrepResult.htmlContent;
    highCount = semgrepResult.highCount;
    mediumCount = semgrepResult.mediumCount;
    lowCount = semgrepResult.lowCount;
  } else if (tool.id === 'npm-audit') {
    stageProgress(5, `Starting npm audit for ${resourceView.name}…`);
    const auditResult = await runNpmAuditScan({
      resource: resourceView,
      onProgress: runnerProgress,
    });
    summary = auditResult.summary;
    htmlContent = auditResult.htmlContent;
    highCount = auditResult.highCount;
    mediumCount = auditResult.mediumCount;
    lowCount = auditResult.lowCount;
  } else if (tool.id === 'gitleaks') {
    stageProgress(5, `Starting Gitleaks scan for ${resourceView.name}…`);
    const gitleaksResult = await runGitleaksScan({
      resource: resourceView,
      onProgress: runnerProgress,
    });
    summary = gitleaksResult.summary;
    htmlContent = gitleaksResult.htmlContent;
    highCount = gitleaksResult.highCount;
    mediumCount = gitleaksResult.mediumCount;
    lowCount = gitleaksResult.lowCount;
  } else {
    stageProgress(15, `Generating ${tool.name} report…`);
    summary = `Security assessment report for ${resourceView.name} using ${tool.name}. Review findings and remediate high-severity items first.`;
    const counts =
      tool.category === 'sca'
        ? countScaDependenciesBySeverity(tool.id)
        : countFindingsBySeverity(sampleFindings(tool.id));
    htmlContent = buildSecurityReportHtml({
      resource: resourceView,
      tool,
      title,
      summary,
    });
    highCount = counts.high;
    mediumCount = counts.medium;
    lowCount = counts.low;
  }

  stageProgress(96, 'Saving report…');
  const row = await prisma.securityReport.create({
    data: {
      resourceId: resource.id,
      toolId: tool.id,
      scanJobId: input.scanJobId ?? null,
      title,
      status: 'completed',
      summary,
      htmlContent,
      highCount,
      mediumCount,
      lowCount,
    },
    include: { resource: { select: { name: true } } },
  });

  return {
    id: row.id,
    resourceId: row.resourceId,
    resourceName: row.resource?.name ?? null,
    toolId: row.toolId,
    toolName: tool.name,
    title: row.title,
    status: row.status,
    summary: row.summary,
    highCount: row.highCount,
    mediumCount: row.mediumCount,
    lowCount: row.lowCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function finalizeScanProgress(
  onProgress: ScanProgressCallback | undefined,
  pairIndex: number,
  pairTotal: number,
  message: string,
  meta: { resourceId: string; toolId: string }
): void {
  emitScanProgress(onProgress, pairIndex, pairTotal, 100, message, meta);
}

export async function runResourceScans(resourceId: string): Promise<SecurityReportView[]> {
  const resource = await prisma.securityResource.findUnique({ where: { id: resourceId } });
  if (!resource) throw new Error('Resource not found');
  const toolSettings = await listSecurityToolSettings();
  const enabledIds = new Set(
    toolSettings.filter((row) => row.enabled).map((row) => row.toolId)
  );
  const tools = compatibleToolsForResource(resource.type as SecurityResourceType, enabledIds);
  return runSecurityScans({
    resourceIds: [resourceId],
    toolIds: tools.map((tool) => tool.id),
  });
}

export async function runSecurityScans(
  input: {
    resourceIds: string[];
    toolIds: string[];
  },
  onProgress?: ScanProgressCallback,
  options?: { scanJobId?: string }
): Promise<SecurityReportView[]> {
  await assertSecurityModuleEnabled();
  if (!input.resourceIds.length) throw new Error('Select at least one target');
  if (!input.toolIds.length) throw new Error('Select at least one tool');

  const resources = await prisma.securityResource.findMany({
    where: { id: { in: input.resourceIds } },
  });
  if (resources.length !== input.resourceIds.length) {
    throw new Error('One or more targets were not found');
  }
  const disabled = resources.filter((row) => !row.enabled);
  if (disabled.length) {
    throw new Error(`Disabled targets: ${disabled.map((row) => row.name).join(', ')}`);
  }

  const toolSettings = await listSecurityToolSettings();
  const enabledIds = new Set(
    toolSettings.filter((row) => row.enabled).map((row) => row.toolId)
  );

  const pairs = resolveScanPairs({
    resources: resources.map((row) => ({
      id: row.id,
      type: row.type as SecurityResourceType,
    })),
    toolIds: input.toolIds,
    enabledToolIds: enabledIds,
  });

  if (pairs.length === 0) {
    throw new Error('No valid target and tool combinations for this scan');
  }

  if (onProgress) {
    onProgress({
      type: 'progress',
      progress: 1,
      message: `Starting ${pairs.length} scan${pairs.length === 1 ? '' : 's'}…`,
      pairIndex: 0,
      pairTotal: pairs.length,
    });
  }

  const reports: SecurityReportView[] = [];
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    const tool = getSecurityToolById(pair.toolId);
    const resource = resources.find((row) => row.id === pair.resourceId);
    const label = `${tool?.name ?? pair.toolId} · ${resource?.name ?? pair.resourceId}`;

    emitScanProgress(
      onProgress,
      index,
      pairs.length,
      0,
      `Scan ${index + 1} of ${pairs.length}: ${label}`,
      pair
    );

    reports.push(
      await generateSecurityReport({
        ...pair,
        scanJobId: options?.scanJobId,
        pairIndex: index,
        pairTotal: pairs.length,
        onProgress,
      })
    );

    finalizeScanProgress(
      onProgress,
      index,
      pairs.length,
      `Completed ${index + 1} of ${pairs.length}: ${label}`,
      pair
    );
  }

  if (onProgress) {
    onProgress({
      type: 'progress',
      progress: 100,
      message: 'All scans completed',
      pairIndex: pairs.length,
      pairTotal: pairs.length,
    });
  }
  return reports;
}

export async function getSecurityDashboardStats(): Promise<SecurityDashboardStats> {
  await assertSecurityModuleEnabled();

  const [resources, toolSettings, reports] = await Promise.all([
    prisma.securityResource.findMany(),
    listSecurityToolSettings(),
    prisma.securityReport.findMany({
      orderBy: { createdAt: 'desc' },
      include: { resource: { select: { name: true } } },
      take: 200,
    }),
  ]);

  let high = 0;
  let medium = 0;
  let low = 0;
  const toolAgg = new Map<
    string,
    { scans: number; high: number; medium: number; low: number }
  >();

  for (const row of reports) {
    high += row.highCount;
    medium += row.mediumCount;
    low += row.lowCount;
    const existing = toolAgg.get(row.toolId) ?? { scans: 0, high: 0, medium: 0, low: 0 };
    existing.scans += 1;
    existing.high += row.highCount;
    existing.medium += row.mediumCount;
    existing.low += row.lowCount;
    toolAgg.set(row.toolId, existing);
  }

  const byTool = Array.from(toolAgg.entries())
    .map(([toolId, stats]) => ({
      toolId,
      toolName: getSecurityToolById(toolId)?.name ?? toolId,
      ...stats,
    }))
    .sort((a, b) => b.scans - a.scans);

  const recentScans = reports.slice(0, 8).map((row) => ({
    id: row.id,
    resourceId: row.resourceId,
    resourceName: row.resource?.name ?? null,
    toolId: row.toolId,
    toolName: getSecurityToolById(row.toolId)?.name ?? row.toolId,
    title: row.title,
    status: row.status,
    summary: row.summary,
    highCount: row.highCount,
    mediumCount: row.mediumCount,
    lowCount: row.lowCount,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    totals: {
      scans: reports.length,
      resources: resources.length,
      enabledResources: resources.filter((row) => row.enabled).length,
      enabledTools: toolSettings.filter((row) => row.enabled).length,
      high,
      medium,
      low,
    },
    bySeverity: [
      { label: 'High', count: high, color: '#dc2626' },
      { label: 'Medium', count: medium, color: '#d97706' },
      { label: 'Low', count: low, color: '#2563eb' },
    ],
    byTool,
    recentScans,
  };
}

export async function getSecurityReportHtml(id: string): Promise<{ title: string; html: string }> {
  await assertSecurityModuleEnabled();
  const row = await prisma.securityReport.findUnique({ where: { id } });
  if (!row) throw new Error('Report not found');
  return { title: row.title, html: row.htmlContent };
}

export async function getSecurityReportPdfBuffer(id: string): Promise<{ title: string; buffer: Buffer }> {
  await assertSecurityModuleEnabled();
  const row = await prisma.securityReport.findUnique({
    where: { id },
    include: { resource: true },
  });
  if (!row) throw new Error('Report not found');
  const tool = getSecurityToolById(row.toolId);
  if (!tool) throw new Error('Unknown tool on report');

  const resourceView = row.resource ? toResourceView(row.resource) : null;
  const buffer = await securityReportToPdfBuffer({
    resource: resourceView,
    tool,
    title: row.title,
    summary: row.summary ?? '',
    severityCounts: {
      high: row.highCount,
      medium: row.mediumCount,
      low: row.lowCount,
    },
  });
  return { title: row.title, buffer };
}
