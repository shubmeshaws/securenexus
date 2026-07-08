import prisma from './prisma';
import { getSecurityModuleEnabled } from './settings';
import { SECURITY_TOOLS, getSecurityToolById, resolveScanPairs, compatibleToolsForResource } from './security-tools';
import { buildSecurityReportHtml, countFindingsBySeverity, countScaDependenciesBySeverity, sampleFindings } from './security-report-export';
import { buildMergedSecurityReportHtml } from './security-report-merge';
import {
  aggregateDashboardFromReports,
  isCombinedSecurityReportTitle,
  selectLatestScanReports,
  type SecurityDashboardEnvironmentFinding,
  type SecurityDashboardRepoFinding,
  type SecurityDashboardUrlFinding,
} from './security-dashboard-stats';
import { buildSecurityReportCsv } from './security-report-csv';
import { htmlToPdfBuffer } from './security-html-to-pdf';
import { categoryReportLabel } from './security-report-html';
import { sanitizePostgresText } from './utils';
import type { SecurityReportMode } from './security-scan-types';
import { runSemgrepScan } from './security/semgrep-runner';
import { runNpmAuditScan } from './security/npm-audit-runner';
import { runPipAuditScan } from './security/pip-audit-runner';
import { runGovulncheckScan } from './security/govulncheck-runner';
import { runGitleaksScan } from './security/gitleaks-runner';
import { runZapScan } from './security/zap-runner';
import { runSnykScaScan, runSnykCodeScan, isSnykAuthenticated, readSnykWhoami } from './security/snyk-runner';
import {
  DEFAULT_GITLEAKS_SCAN_OPTIONS,
  parseGitleaksScanOptions,
  type GitleaksScanOptions,
} from './security/gitleaks-options';
import {
  getToolRuntimeStatus,
  installToolRuntime,
  isRuntimeSecurityTool,
  type ServerOsType,
} from './security/tool-runtime';
import { isSnykToolId, resolveSharedSnykInstall, SNYK_TOOL_IDS } from './security/snyk-shared';
import { getInstallCommandsByOs, getInstallCommandsForOs, isServerOsType } from './security/tool-install-specs';
import { scheduleReportPdfRuntimeInstall, ensureReportPdfRuntimeInstalled } from './security/report-pdf-runtime';

import { emitScanProgress, type ScanProgressCallback } from './security-scan-progress';
import { isScanJobCancelRequested, ScanCancelledError } from './security-scan-cancel';
import { throwIfScanJobCancelled } from './security-scan-exec';
import {
  cloneSecurityResourceRepo,
  getSecurityResourceCloneStatus,
  getSecurityResourceCloneStatuses,
  pullSecurityResourceRepo,
  removeSecurityResourceClone,
  type SecurityResourceCloneStatus,
} from './security/security-repo-prep';

const SECURITY_DASHBOARD_CACHE_TTL_MS = 60_000;
let securityDashboardCache: { at: number; data: SecurityDashboardStats } | null = null;
let toolSettingsSeeded = false;
const TOOL_SETTINGS_CACHE_TTL_MS = 120_000;
let toolSettingsFullCache: { at: number; data: SecurityToolSettingView[] } | null = null;
let toolSettingsLiteCache: { at: number; data: SecurityToolSettingView[] } | null = null;
let securityWorkbenchCache: {
  at: number;
  data: { resources: SecurityResourceView[]; tools: SecurityToolSettingView[] };
} | null = null;
const SECURITY_WORKBENCH_CACHE_TTL_MS = 60_000;

const SECURITY_REPORT_LIST_SELECT = {
  id: true,
  resourceId: true,
  toolId: true,
  title: true,
  status: true,
  summary: true,
  highCount: true,
  mediumCount: true,
  lowCount: true,
  createdAt: true,
  resource: { select: { name: true } },
  scanJob: { select: { toolIds: true } },
} as const;

const SECURITY_DASHBOARD_REPORT_SELECT = {
  id: true,
  resourceId: true,
  toolId: true,
  scanJobId: true,
  title: true,
  status: true,
  summary: true,
  highCount: true,
  mediumCount: true,
  lowCount: true,
  createdAt: true,
  resource: {
    select: {
      id: true,
      type: true,
      name: true,
      repoUrl: true,
      defaultBranch: true,
      targetUrl: true,
    },
  },
  scanJob: { select: { toolIds: true } },
} as const;

export function invalidateSecurityDashboardCache(): void {
  securityDashboardCache = null;
}

export function invalidateSecurityToolSettingsCache(): void {
  toolSettingsFullCache = null;
  toolSettingsLiteCache = null;
  securityWorkbenchCache = null;
}

export type { ScanProgressCallback, ScanProgressUpdate } from './security-scan-progress';
export type { SecurityResourceCloneStatus } from './security/security-repo-prep';
export type { SecurityReportMode } from './security-scan-types';

interface SecurityScanPairResult {
  resourceId: string;
  toolId: string;
  toolName: string;
  resourceName: string;
  categoryLabel: string;
  title: string;
  summary: string;
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

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
  installCommandsByOs: Record<ServerOsType, string[]> | null;
  scanOptions: GitleaksScanOptions | null;
  runtimeAuthenticated?: boolean | null;
  runtimeUsername?: string | null;
}

export interface SecurityReportView {
  id: string;
  resourceId: string | null;
  resourceName: string | null;
  toolId: string;
  toolName: string;
  toolNames: string[];
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
    repositoriesScanned: number;
    urlTargetsScanned: number;
  };
  bySeverity: { label: string; count: number; color: string }[];
  byTool: {
    toolId: string;
    toolName: string;
    scans: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  }[];
  byRepository: SecurityDashboardRepoFinding[];
  byUrlTarget: SecurityDashboardUrlFinding[];
  byEnvironment: SecurityDashboardEnvironmentFinding[];
  highlights: {
    mostVulnerableRepository: SecurityDashboardRepoFinding | null;
    mostVulnerableUrl: SecurityDashboardUrlFinding | null;
  };
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

export async function listSecurityResources(options?: {
  includeClone?: boolean;
}): Promise<SecurityResourceView[]> {
  await assertSecurityModuleEnabled();
  const rows = await prisma.securityResource.findMany({
    orderBy: { createdAt: 'desc' },
  });
  if (options?.includeClone === false) {
    return rows.map((row) => toResourceView(row));
  }

  const repoIds = rows
    .filter((row) => row.type === 'repository')
    .map((row) => row.id);
  const cloneStatuses = await getSecurityResourceCloneStatuses(repoIds);
  const emptyClone: SecurityResourceCloneStatus = {
    cloned: false,
    clonedAt: null,
    lastPulledAt: null,
  };

  return rows.map((row) => {
    const view = toResourceView(row);
    if (view.type === 'repository') {
      view.clone = cloneStatuses.get(view.id) ?? emptyClone;
    }
    return view;
  });
}

export async function getSecurityWorkbenchData(): Promise<{
  resources: SecurityResourceView[];
  tools: SecurityToolSettingView[];
}> {
  if (
    securityWorkbenchCache &&
    Date.now() - securityWorkbenchCache.at < SECURITY_WORKBENCH_CACHE_TTL_MS
  ) {
    return securityWorkbenchCache.data;
  }

  const [resources, tools] = await Promise.all([
    listSecurityResources({ includeClone: false }),
    listSecurityToolSettings({ checkRuntime: false }),
  ]);

  const data = { resources, tools };
  securityWorkbenchCache = { at: Date.now(), data };
  return data;
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
    invalidateSecurityToolSettingsCache();
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
  invalidateSecurityToolSettingsCache();
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
  invalidateSecurityToolSettingsCache();
}

export async function deleteSecurityReport(id: string): Promise<void> {
  await assertSecurityModuleEnabled();
  const row = await prisma.securityReport.findUnique({ where: { id } });
  if (!row) throw new Error('Report not found');
  await prisma.securityReport.delete({ where: { id } });
  invalidateSecurityDashboardCache();
}

async function ensureToolSettingsSeeded(): Promise<void> {
  if (toolSettingsSeeded) {
    const count = await prisma.securityToolSetting.count();
    if (count >= SECURITY_TOOLS.length) return;
  }

  for (const tool of SECURITY_TOOLS) {
    await prisma.securityToolSetting.upsert({
      where: { toolId: tool.id },
      create: {
        toolId: tool.id,
        enabled: false,
        ...(tool.id === 'gitleaks'
          ? { scanOptions: DEFAULT_GITLEAKS_SCAN_OPTIONS as object }
          : {}),
      },
      update: {},
    });
  }
  toolSettingsSeeded = true;
}

async function scheduleReportPdfRuntimeIfNeeded(): Promise<void> {
  const enabledCount = await prisma.securityToolSetting.count({ where: { enabled: true } });
  if (enabledCount > 0) {
    scheduleReportPdfRuntimeInstall();
    void ensureReportPdfRuntimeInstalled().catch((err) => {
      console.error(
        '[report-pdf-runtime] background install after tool enable failed:',
        err instanceof Error ? err.message : err
      );
    });
  }
}

export async function listSecurityToolSettings(options?: {
  checkRuntime?: boolean;
}): Promise<SecurityToolSettingView[]> {
  await assertSecurityModuleEnabled();
  await ensureToolSettingsSeeded();

  const checkRuntime = options?.checkRuntime !== false;

  if (checkRuntime && toolSettingsFullCache) {
    if (Date.now() - toolSettingsFullCache.at < TOOL_SETTINGS_CACHE_TTL_MS) {
      return toolSettingsFullCache.data;
    }
  }
  if (!checkRuntime && toolSettingsLiteCache) {
    if (Date.now() - toolSettingsLiteCache.at < TOOL_SETTINGS_CACHE_TTL_MS) {
      return toolSettingsLiteCache.data;
    }
  }

  const rows = await prisma.securityToolSetting.findMany();
  const byId = new Map(rows.map((row) => [row.toolId, row]));
  const sharedSnykInstall = resolveSharedSnykInstall(byId);

  if (!checkRuntime) {
    const tools = SECURITY_TOOLS.map((tool) => {
      const row = byId.get(tool.id);
      const runtimeRequired = isRuntimeSecurityTool(tool.id);
      const installedOs =
        isSnykToolId(tool.id) && sharedSnykInstall.installedOs
          ? isServerOsType(sharedSnykInstall.installedOs)
            ? sharedSnykInstall.installedOs
            : null
          : row?.installedOs && isServerOsType(row.installedOs)
            ? row.installedOs
            : null;
      const installedAt = isSnykToolId(tool.id)
        ? sharedSnykInstall.installedAt
        : row?.installedAt ?? null;
      return {
        toolId: tool.id,
        enabled: row?.enabled ?? false,
        runtimeRequired,
        runtimeAvailable: !runtimeRequired || Boolean(installedAt),
        runtimeReady: Boolean(installedAt),
        installedAt: installedAt?.toISOString() ?? null,
        installedOs,
        runtimeVersion: null,
        installCommands: installedOs ? getInstallCommandsForOs(tool.id, installedOs) : [],
        installCommandsByOs: runtimeRequired ? getInstallCommandsByOs(tool.id) : null,
        scanOptions:
          tool.id === 'gitleaks' ? parseGitleaksScanOptions(row?.scanOptions) : null,
        runtimeAuthenticated: null,
      };
    });
    toolSettingsLiteCache = { at: Date.now(), data: tools };
    return tools;
  }

  const tools = await Promise.all(
    SECURITY_TOOLS.map(async (tool) => {
      const row = byId.get(tool.id);
      const runtimeRequired = isRuntimeSecurityTool(tool.id);
      const snykInstalledAt = isSnykToolId(tool.id)
        ? sharedSnykInstall.installedAt
        : row?.installedAt ?? null;
      const snykInstalledOs =
        isSnykToolId(tool.id) && sharedSnykInstall.installedOs
          ? sharedSnykInstall.installedOs
          : row?.installedOs ?? null;
      const needsRuntimeProbe =
        runtimeRequired && Boolean(row?.enabled || snykInstalledAt);

      if (!needsRuntimeProbe) {
        const installedOs =
          snykInstalledOs && isServerOsType(snykInstalledOs) ? snykInstalledOs : null;
        return {
          toolId: tool.id,
          enabled: row?.enabled ?? false,
          runtimeRequired,
          runtimeAvailable: !runtimeRequired || Boolean(snykInstalledAt),
          runtimeReady: Boolean(snykInstalledAt),
          installedAt: snykInstalledAt?.toISOString() ?? null,
          installedOs,
          runtimeVersion: null,
          installCommands: installedOs ? getInstallCommandsForOs(tool.id, installedOs) : [],
          installCommandsByOs: runtimeRequired ? getInstallCommandsByOs(tool.id) : null,
          scanOptions:
            tool.id === 'gitleaks' ? parseGitleaksScanOptions(row?.scanOptions) : null,
          runtimeAuthenticated: null,
        };
      }

      const runtime = await getToolRuntimeStatus(
        tool.id,
        snykInstalledAt,
        snykInstalledOs
      );
      const runtimeAuthenticated =
        isSnykToolId(tool.id) && runtime.runtimeAvailable
          ? await isSnykAuthenticated()
          : null;
      const runtimeUsername =
        isSnykToolId(tool.id) && runtimeAuthenticated ? await readSnykWhoami() : null;
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
        installCommandsByOs: getInstallCommandsByOs(tool.id),
        scanOptions:
          tool.id === 'gitleaks' ? parseGitleaksScanOptions(row?.scanOptions) : null,
        runtimeAuthenticated,
        runtimeUsername,
      };
    })
  );

  if (tools.some((tool) => tool.enabled)) {
    scheduleReportPdfRuntimeInstall();
  }

  toolSettingsFullCache = { at: Date.now(), data: tools };
  return tools;
}

export async function setSecurityToolEnabled(toolId: string, enabled: boolean): Promise<void> {
  await assertSecurityModuleEnabled();
  const tool = getSecurityToolById(toolId);
  if (!tool) throw new Error('Unknown security tool');
  await ensureToolSettingsSeeded();

  if (enabled && isRuntimeSecurityTool(toolId)) {
    const row = await prisma.securityToolSetting.findUnique({ where: { toolId } });
    if (isSnykToolId(toolId)) {
      const rows = await prisma.securityToolSetting.findMany({
        where: { toolId: { in: [...SNYK_TOOL_IDS] } },
      });
      const shared = resolveSharedSnykInstall(new Map(rows.map((r) => [r.toolId, r])));
      if (!shared.installedAt && !row?.installedAt) {
        throw new Error(
          `${tool.name} must be installed on this server before it can be enabled. Install Snyk once from either SCA or SAST — both share the same CLI.`
        );
      }
    } else if (!row?.installedAt) {
      throw new Error(`${tool.name} must be installed on this server before it can be enabled.`);
    }
  }

  await prisma.securityToolSetting.upsert({
    where: { toolId },
    create: { toolId, enabled },
    update: { enabled },
  });

  if (enabled) {
    await scheduleReportPdfRuntimeIfNeeded();
  }
  invalidateSecurityToolSettingsCache();
}

export async function updateSecurityToolScanOptions(
  toolId: string,
  scanOptions: GitleaksScanOptions
): Promise<SecurityToolSettingView[]> {
  await assertSecurityModuleEnabled();
  const tool = getSecurityToolById(toolId);
  if (!tool) throw new Error('Unknown security tool');
  if (toolId !== 'gitleaks') {
    throw new Error('Scan options are only configurable for Gitleaks.');
  }

  await ensureToolSettingsSeeded();
  await prisma.securityToolSetting.upsert({
    where: { toolId },
    create: {
      toolId,
      enabled: false,
      scanOptions: scanOptions as object,
    },
    update: { scanOptions: scanOptions as object },
  });

  invalidateSecurityToolSettingsCache();
  return listSecurityToolSettings();
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

  const upsertInstall = async (id: string, enableThis: boolean) => {
    await prisma.securityToolSetting.upsert({
      where: { toolId: id },
      create: {
        toolId: id,
        enabled: enableThis,
        installedAt,
        installedOs: options.osType,
      },
      update: {
        installedAt,
        installedOs: options.osType,
        ...(enableThis ? { enabled: true } : {}),
      },
    });
  };

  if (isSnykToolId(toolId)) {
    for (const id of SNYK_TOOL_IDS) {
      await upsertInstall(id, id === toolId && (options?.enableAfter ?? true));
    }
  } else {
    await upsertInstall(toolId, options?.enableAfter ?? true);
  }

  const tools = await listSecurityToolSettings();
  const updated = tools.find((row) => row.toolId === toolId);

  if (options?.enableAfter ?? true) {
    await scheduleReportPdfRuntimeIfNeeded();
  }

  invalidateSecurityToolSettingsCache();
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

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function isCombinedSecurityReport(title: string): boolean {
  return title.toLowerCase().includes('combined security scan');
}

function parseMergedToolNamesFromSummary(summary: string | null): string[] {
  if (!summary?.startsWith('Merged report covering ')) return [];
  const body = summary.slice('Merged report covering '.length).replace(/\.$/, '');
  const names = body.split(', ').map((part) => {
    const splitIndex = part.lastIndexOf(' on ');
    return splitIndex > 0 ? part.slice(0, splitIndex) : part;
  });
  return Array.from(new Set(names.filter(Boolean)));
}

function resolveReportToolNames(input: {
  title: string;
  toolId: string;
  summary: string | null;
  scanJobToolIds?: unknown;
}): string[] {
  if (isCombinedSecurityReport(input.title)) {
    const fromJob = Array.from(
      new Set(
        parseIdList(input.scanJobToolIds).map((id) => getSecurityToolById(id)?.name ?? id)
      )
    ).filter(Boolean);
    if (fromJob.length) return fromJob;

    const fromSummary = parseMergedToolNamesFromSummary(input.summary);
    if (fromSummary.length) return fromSummary;

    return ['Combined scan'];
  }

  return [getSecurityToolById(input.toolId)?.name ?? input.toolId];
}

function toSecurityReportView(
  row: {
    id: string;
    resourceId: string | null;
    toolId: string;
    title: string;
    status: string;
    summary: string | null;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    createdAt: Date;
    resource?: { name: string } | null;
    scanJob?: { toolIds: unknown } | null;
  },
  toolNameOverride?: string
): SecurityReportView {
  const toolNames = resolveReportToolNames({
    title: row.title,
    toolId: row.toolId,
    summary: row.summary,
    scanJobToolIds: row.scanJob?.toolIds,
  });

  return {
    id: row.id,
    resourceId: row.resourceId,
    resourceName: row.resource?.name ?? null,
    toolId: row.toolId,
    toolName: toolNameOverride ?? toolNames[0] ?? row.toolId,
    toolNames,
    title: row.title,
    status: row.status,
    summary: row.summary,
    highCount: row.highCount,
    mediumCount: row.mediumCount,
    lowCount: row.lowCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSecurityReports(): Promise<SecurityReportView[]> {
  await assertSecurityModuleEnabled();
  const rows = await prisma.securityReport.findMany({
    orderBy: { createdAt: 'desc' },
    select: SECURITY_REPORT_LIST_SELECT,
    take: 200,
  });
  return rows.map((row) => toSecurityReportView(row));
}

async function executeSecurityScanPair(input: {
  resourceId: string;
  toolId: string;
  pairIndex?: number;
  pairTotal?: number;
  scanJobId?: string;
  onProgress?: ScanProgressCallback;
}): Promise<SecurityScanPairResult> {
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
    throwIfScanJobCancelled(input.scanJobId);
    stageProgress(stagePercent, message);
  };

  if (tool.id === 'semgrep') {
    stageProgress(5, `Starting Semgrep scan for ${resourceView.name}…`);
    const semgrepResult = await runSemgrepScan({
      resource: resourceView,
      scanJobId: input.scanJobId,
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
      scanJobId: input.scanJobId,
      onProgress: runnerProgress,
    });
    summary = auditResult.summary;
    htmlContent = auditResult.htmlContent;
    highCount = auditResult.highCount;
    mediumCount = auditResult.mediumCount;
    lowCount = auditResult.lowCount;
  } else if (tool.id === 'pip-audit') {
    stageProgress(5, `Starting pip-audit for ${resourceView.name}…`);
    const auditResult = await runPipAuditScan({
      resource: resourceView,
      scanJobId: input.scanJobId,
      onProgress: runnerProgress,
    });
    summary = auditResult.summary;
    htmlContent = auditResult.htmlContent;
    highCount = auditResult.highCount;
    mediumCount = auditResult.mediumCount;
    lowCount = auditResult.lowCount;
  } else if (tool.id === 'govulncheck') {
    stageProgress(5, `Starting govulncheck for ${resourceView.name}…`);
    const auditResult = await runGovulncheckScan({
      resource: resourceView,
      scanJobId: input.scanJobId,
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
      scanOptions: parseGitleaksScanOptions(toolSetting?.scanOptions),
      scanJobId: input.scanJobId,
      onProgress: runnerProgress,
    });
    summary = gitleaksResult.summary;
    htmlContent = gitleaksResult.htmlContent;
    highCount = gitleaksResult.highCount;
    mediumCount = gitleaksResult.mediumCount;
    lowCount = gitleaksResult.lowCount;
  } else if (tool.id === 'zap') {
    stageProgress(5, `Starting OWASP ZAP DAST scan for ${resourceView.name}…`);
    const zapResult = await runZapScan({
      resource: resourceView,
      scanJobId: input.scanJobId,
      onProgress: runnerProgress,
    });
    summary = zapResult.summary;
    htmlContent = zapResult.htmlContent;
    highCount = zapResult.highCount;
    mediumCount = zapResult.mediumCount;
    lowCount = zapResult.lowCount;
  } else if (tool.id === 'snyk') {
    stageProgress(5, `Starting Snyk SCA scan for ${resourceView.name}…`);
    const snykResult = await runSnykScaScan({
      resource: resourceView,
      scanJobId: input.scanJobId,
      onProgress: runnerProgress,
    });
    summary = snykResult.summary;
    htmlContent = snykResult.htmlContent;
    highCount = snykResult.highCount;
    mediumCount = snykResult.mediumCount;
    lowCount = snykResult.lowCount;
  } else if (tool.id === 'snyk-code') {
    stageProgress(5, `Starting Snyk Code scan for ${resourceView.name}…`);
    const snykResult = await runSnykCodeScan({
      resource: resourceView,
      scanJobId: input.scanJobId,
      onProgress: runnerProgress,
    });
    summary = snykResult.summary;
    htmlContent = snykResult.htmlContent;
    highCount = snykResult.highCount;
    mediumCount = snykResult.mediumCount;
    lowCount = snykResult.lowCount;
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

  return {
    resourceId: resource.id,
    toolId: tool.id,
    toolName: tool.name,
    resourceName: resourceView.name,
    categoryLabel: categoryReportLabel(tool.category),
    title,
    summary,
    htmlContent,
    highCount,
    mediumCount,
    lowCount,
  };
}

async function saveSecurityScanReport(
  result: SecurityScanPairResult,
  scanJobId?: string
): Promise<SecurityReportView> {
  const row = await prisma.securityReport.create({
    data: {
      resourceId: result.resourceId,
      toolId: result.toolId,
      scanJobId: scanJobId ?? null,
      title: result.title,
      status: 'completed',
      summary: result.summary,
      htmlContent: sanitizePostgresText(result.htmlContent),
      highCount: result.highCount,
      mediumCount: result.mediumCount,
      lowCount: result.lowCount,
    },
    include: { resource: { select: { name: true } }, scanJob: { select: { toolIds: true } } },
  });

  invalidateSecurityDashboardCache();
  return toSecurityReportView(row, result.toolName);
}

async function saveMergedSecurityScanReport(
  results: SecurityScanPairResult[],
  scanJobId?: string
): Promise<SecurityReportView> {
  const htmlContent = buildMergedSecurityReportHtml(
    results.map((row) => {
      const tool = getSecurityToolById(row.toolId);
      return {
        title: row.title,
        toolName: row.toolName,
        resourceName: row.resourceName,
        category: tool?.category ?? 'sast',
        categoryLabel: row.categoryLabel,
        summary: row.summary,
        htmlContent: row.htmlContent,
        highCount: row.highCount,
        mediumCount: row.mediumCount,
        lowCount: row.lowCount,
      };
    })
  );

  const highCount = results.reduce((sum, row) => sum + row.highCount, 0);
  const mediumCount = results.reduce((sum, row) => sum + row.mediumCount, 0);
  const lowCount = results.reduce((sum, row) => sum + row.lowCount, 0);
  const title = `Combined security scan — ${results.length} assessments`;
  const summary = `Merged report covering ${results
    .map((row) => `${row.toolName} on ${row.resourceName}`)
    .join(', ')}.`;

  const row = await prisma.securityReport.create({
    data: {
      resourceId: results[0]?.resourceId ?? null,
      toolId: results[0]?.toolId ?? 'semgrep',
      scanJobId: scanJobId ?? null,
      title,
      status: 'completed',
      summary,
      htmlContent: sanitizePostgresText(htmlContent),
      highCount,
      mediumCount,
      lowCount,
    },
    include: { resource: { select: { name: true } }, scanJob: { select: { toolIds: true } } },
  });

  invalidateSecurityDashboardCache();
  return toSecurityReportView(row);
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
  const result = await executeSecurityScanPair(input);
  emitScanProgress(
    input.onProgress,
    input.pairIndex ?? 0,
    input.pairTotal ?? 1,
    96,
    'Saving report…',
    { resourceId: input.resourceId, toolId: input.toolId }
  );
  return saveSecurityScanReport(result, input.scanJobId);
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
  options?: { scanJobId?: string; reportMode?: SecurityReportMode }
): Promise<SecurityReportView[]> {
  await assertSecurityModuleEnabled();
  if (!input.resourceIds.length) throw new Error('Select at least one target');
  if (!input.toolIds.length) throw new Error('Select at least one tool');

  const reportMode = options?.reportMode ?? 'separate';
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

  const scanResults: SecurityScanPairResult[] = [];
  for (let index = 0; index < pairs.length; index++) {
    if (options?.scanJobId && isScanJobCancelRequested(options.scanJobId)) {
      throw new ScanCancelledError();
    }

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

    scanResults.push(
      await executeSecurityScanPair({
        ...pair,
        pairIndex: index,
        pairTotal: pairs.length,
        scanJobId: options?.scanJobId,
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
      progress: 99,
      message: 'Finalizing reports…',
      pairIndex: pairs.length,
      pairTotal: pairs.length,
    });
  }

  if (options?.scanJobId && isScanJobCancelRequested(options.scanJobId)) {
    throw new ScanCancelledError();
  }

  let reports: SecurityReportView[];
  if (reportMode === 'merged' && scanResults.length > 1) {
    if (onProgress) {
      onProgress({
        type: 'progress',
        progress: 98,
        message: 'Merging reports into one document…',
        pairIndex: pairs.length,
        pairTotal: pairs.length,
      });
    }
    reports = [await saveMergedSecurityScanReport(scanResults, options?.scanJobId)];
  } else {
    if (onProgress) {
      onProgress({
        type: 'progress',
        progress: 96,
        message: 'Saving reports…',
        pairIndex: pairs.length,
        pairTotal: pairs.length,
      });
    }
    reports = await Promise.all(
      scanResults.map((result) => saveSecurityScanReport(result, options?.scanJobId))
    );
  }

  if (onProgress) {
    onProgress({
      type: 'progress',
      progress: 100,
      message: reportMode === 'merged' && scanResults.length > 1 ? 'Merged report completed' : 'All scans completed',
      pairIndex: pairs.length,
      pairTotal: pairs.length,
    });
  }
  return reports;
}

export async function getSecurityDashboardStats(): Promise<SecurityDashboardStats> {
  await assertSecurityModuleEnabled();

  if (
    securityDashboardCache &&
    Date.now() - securityDashboardCache.at < SECURITY_DASHBOARD_CACHE_TTL_MS
  ) {
    return securityDashboardCache.data;
  }

  const [resources, enabledToolsCount, reports] = await Promise.all([
    prisma.securityResource.findMany(),
    prisma.securityToolSetting.count({ where: { enabled: true } }),
    prisma.securityReport.findMany({
      orderBy: { createdAt: 'desc' },
      select: SECURITY_DASHBOARD_REPORT_SELECT,
      take: 500,
    }),
  ]);

  const latestReports = selectLatestScanReports(reports);
  const combinedIds = latestReports
    .filter((row) => isCombinedSecurityReportTitle(row.title))
    .map((row) => row.id);

  const combinedHtmlById = new Map<string, string>();
  if (combinedIds.length) {
    const htmlRows = await prisma.securityReport.findMany({
      where: { id: { in: combinedIds } },
      select: { id: true, htmlContent: true },
    });
    for (const row of htmlRows) {
      combinedHtmlById.set(row.id, row.htmlContent);
    }
  }

  const reportsWithHtml = reports.map((row) => ({
    ...row,
    htmlContent: combinedHtmlById.get(row.id),
  }));

  const aggregated = aggregateDashboardFromReports(reportsWithHtml);

  const byTool = Array.from(aggregated.byTool.entries())
    .map(([toolId, stats]) => ({
      toolId,
      toolName: getSecurityToolById(toolId)?.name ?? toolId,
      ...stats,
      total: stats.high + stats.medium + stats.low,
    }))
    .sort((a, b) => b.total - a.total);

  const recentScans = reports.slice(0, 8).map((row) => toSecurityReportView(row));

  const data: SecurityDashboardStats = {
    totals: {
      scans: reports.length,
      resources: resources.length,
      enabledResources: resources.filter((row) => row.enabled).length,
      enabledTools: enabledToolsCount,
      high: aggregated.high,
      medium: aggregated.medium,
      low: aggregated.low,
      repositoriesScanned: aggregated.byRepository.length,
      urlTargetsScanned: aggregated.byUrlTarget.length,
    },
    bySeverity: [
      { label: 'High', count: aggregated.high, color: '#dc2626' },
      { label: 'Medium', count: aggregated.medium, color: '#d97706' },
      { label: 'Low', count: aggregated.low, color: '#2563eb' },
    ],
    byTool,
    byRepository: aggregated.byRepository.slice(0, 10),
    byUrlTarget: aggregated.byUrlTarget.slice(0, 10),
    byEnvironment: aggregated.byEnvironment,
    highlights: {
      mostVulnerableRepository: aggregated.mostVulnerableRepository,
      mostVulnerableUrl: aggregated.mostVulnerableUrl,
    },
    recentScans,
  };

  securityDashboardCache = { at: Date.now(), data };
  return data;
}

export async function getSecurityReportHtml(id: string): Promise<{ title: string; html: string }> {
  await assertSecurityModuleEnabled();
  const row = await prisma.securityReport.findUnique({ where: { id } });
  if (!row) throw new Error('Report not found');
  return { title: row.title, html: row.htmlContent };
}

export async function getSecurityReportPdfBuffer(id: string): Promise<{ title: string; buffer: Buffer }> {
  await assertSecurityModuleEnabled();
  const row = await prisma.securityReport.findUnique({ where: { id } });
  if (!row) throw new Error('Report not found');
  const buffer = await htmlToPdfBuffer(row.htmlContent);
  return { title: row.title, buffer };
}

export async function getSecurityReportCsv(id: string): Promise<{ title: string; csv: string }> {
  await assertSecurityModuleEnabled();
  const row = await prisma.securityReport.findUnique({
    where: { id },
    include: {
      resource: { select: { name: true } },
      scanJob: { select: { toolIds: true } },
    },
  });
  if (!row) throw new Error('Report not found');

  const view = toSecurityReportView(row);
  const csv = buildSecurityReportCsv({
    title: view.title,
    toolNames: view.toolNames,
    resourceName: view.resourceName,
    summary: view.summary,
    htmlContent: row.htmlContent,
    highCount: view.highCount,
    mediumCount: view.mediumCount,
    lowCount: view.lowCount,
    createdAt: view.createdAt,
  });

  return { title: row.title, csv };
}
