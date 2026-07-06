import { SECURITY_TOOLS } from './security-tools';

export interface SecurityDashboardResourceFinding {
  resourceId: string;
  name: string;
  high: number;
  medium: number;
  low: number;
  total: number;
  scanCount: number;
}

export interface SecurityDashboardRepoFinding extends SecurityDashboardResourceFinding {
  repoUrl: string;
  defaultBranch: string | null;
}

export interface SecurityDashboardUrlFinding extends SecurityDashboardResourceFinding {
  targetUrl: string;
}

export interface SecurityDashboardEnvironmentFinding {
  environment: string;
  repositories: number;
  urlTargets: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

type DashboardReportRow = {
  id: string;
  resourceId: string | null;
  toolId: string;
  scanJobId: string | null;
  title: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  createdAt: Date;
  htmlContent?: string;
  resource?: {
    id: string;
    type: string;
    name: string;
    repoUrl: string | null;
    defaultBranch: string | null;
    targetUrl: string | null;
  } | null;
};

const ENV_PATTERNS: [RegExp, string][] = [
  [/(?:^|[-_/])(prod|production)(?:$|[-_/])/i, 'Production'],
  [/(?:^|[-_/])(dev|develop|development)(?:$|[-_/])/i, 'DEV'],
  [/(?:^|[-_/])(stg|staging)(?:$|[-_/])/i, 'Staging'],
  [/(?:^|[-_/])(uat)(?:$|[-_/])/i, 'UAT'],
  [/(?:^|[-_/])(qa|test|testing)(?:$|[-_/])/i, 'QA'],
];

export function isCombinedSecurityReportTitle(title: string): boolean {
  return title.toLowerCase().includes('combined security scan');
}

export function inferSecurityResourceEnvironment(
  name: string,
  repoUrl?: string | null,
  targetUrl?: string | null
): string {
  const haystack = [name, repoUrl, targetUrl].filter(Boolean).join(' ');
  for (const [pattern, label] of ENV_PATTERNS) {
    if (pattern.test(haystack)) return label;
  }
  return 'General';
}

export function parseMergedReportToolBreakdown(
  htmlContent: string
): { toolName: string; high: number; medium: number; low: number }[] {
  const tableMatch = htmlContent.match(
    /<h2>\s*Scans Included\s*<\/h2>\s*<table class="repo-table">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i
  );
  if (!tableMatch?.[1]) return [];

  const results: { toolName: string; high: number; medium: number; low: number }[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
    const cellMatches = Array.from(rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi));
    const cells = cellMatches.map((match) => match[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 6) continue;
    results.push({
      toolName: cells[1],
      high: Number.parseInt(cells[3], 10) || 0,
      medium: Number.parseInt(cells[4], 10) || 0,
      low: Number.parseInt(cells[5], 10) || 0,
    });
  }
  return results;
}

function resolveToolIdFromName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  const match = SECURITY_TOOLS.find((tool) => tool.name.toLowerCase() === normalized);
  return match?.id ?? normalized.replace(/\s+/g, '-');
}

/** Latest scan per resource — one merged report or latest report per tool in the same job. */
export function selectLatestScanReports(reports: DashboardReportRow[]): DashboardReportRow[] {
  const byResource = new Map<string, DashboardReportRow[]>();

  for (const row of reports) {
    if (!row.resourceId) continue;
    const list = byResource.get(row.resourceId) ?? [];
    list.push(row);
    byResource.set(row.resourceId, list);
  }

  const selected: DashboardReportRow[] = [];

  for (const rows of Array.from(byResource.values())) {
    rows.sort((a: DashboardReportRow, b: DashboardReportRow) => b.createdAt.getTime() - a.createdAt.getTime());
    const latestJobId = rows[0]?.scanJobId;

    if (latestJobId) {
      const jobReports = rows.filter((row: DashboardReportRow) => row.scanJobId === latestJobId);
      const combined = jobReports.find((row: DashboardReportRow) =>
        isCombinedSecurityReportTitle(row.title)
      );
      if (combined) {
        selected.push(combined);
        continue;
      }

      const seenTools = new Set<string>();
      for (const row of jobReports) {
        if (seenTools.has(row.toolId)) continue;
        seenTools.add(row.toolId);
        selected.push(row);
      }
      continue;
    }

    const seenTools = new Set<string>();
    for (const row of rows) {
      if (seenTools.has(row.toolId)) continue;
      seenTools.add(row.toolId);
      selected.push(row);
    }
  }

  return selected;
}

type ToolAgg = { scans: number; high: number; medium: number; low: number };

export function aggregateDashboardFromReports(reports: DashboardReportRow[]): {
  high: number;
  medium: number;
  low: number;
  byTool: Map<string, ToolAgg>;
  byRepository: SecurityDashboardRepoFinding[];
  byUrlTarget: SecurityDashboardUrlFinding[];
  byEnvironment: SecurityDashboardEnvironmentFinding[];
  mostVulnerableRepository: SecurityDashboardRepoFinding | null;
  mostVulnerableUrl: SecurityDashboardUrlFinding | null;
} {
  const latestReports = selectLatestScanReports(reports);
  const toolAgg = new Map<string, ToolAgg>();
  const repoAgg = new Map<string, SecurityDashboardRepoFinding>();
  const urlAgg = new Map<string, SecurityDashboardUrlFinding>();
  const envAgg = new Map<
    string,
    { repositories: Set<string>; urlTargets: Set<string>; high: number; medium: number; low: number }
  >();

  let high = 0;
  let medium = 0;
  let low = 0;

  const addToolCounts = (toolKey: string, h: number, m: number, l: number) => {
    const existing = toolAgg.get(toolKey) ?? { scans: 0, high: 0, medium: 0, low: 0 };
    existing.scans += 1;
    existing.high += h;
    existing.medium += m;
    existing.low += l;
    toolAgg.set(toolKey, existing);
  };

  for (const row of latestReports) {
    high += row.highCount;
    medium += row.mediumCount;
    low += row.lowCount;

    if (isCombinedSecurityReportTitle(row.title) && row.htmlContent) {
      for (const part of parseMergedReportToolBreakdown(row.htmlContent)) {
        const toolId = resolveToolIdFromName(part.toolName);
        addToolCounts(toolId, part.high, part.medium, part.low);
      }
    } else {
      addToolCounts(row.toolId, row.highCount, row.mediumCount, row.lowCount);
    }

    const resource = row.resource;
    if (!resource || !row.resourceId) continue;

    const environment = inferSecurityResourceEnvironment(
      resource.name,
      resource.repoUrl,
      resource.targetUrl
    );
    const envEntry = envAgg.get(environment) ?? {
      repositories: new Set<string>(),
      urlTargets: new Set<string>(),
      high: 0,
      medium: 0,
      low: 0,
    };
    envEntry.high += row.highCount;
    envEntry.medium += row.mediumCount;
    envEntry.low += row.lowCount;
    if (resource.type === 'repository') {
      envEntry.repositories.add(resource.id);
    } else {
      envEntry.urlTargets.add(resource.id);
    }
    envAgg.set(environment, envEntry);

    if (resource.type === 'repository' && resource.repoUrl) {
      const existing = repoAgg.get(resource.id) ?? {
        resourceId: resource.id,
        name: resource.name,
        repoUrl: resource.repoUrl,
        defaultBranch: resource.defaultBranch,
        high: 0,
        medium: 0,
        low: 0,
        total: 0,
        scanCount: 0,
      };
      existing.high += row.highCount;
      existing.medium += row.mediumCount;
      existing.low += row.lowCount;
      existing.total = existing.high + existing.medium + existing.low;
      existing.scanCount += 1;
      repoAgg.set(resource.id, existing);
    }

    if (resource.type === 'target_url' && resource.targetUrl) {
      const existing = urlAgg.get(resource.id) ?? {
        resourceId: resource.id,
        name: resource.name,
        targetUrl: resource.targetUrl,
        high: 0,
        medium: 0,
        low: 0,
        total: 0,
        scanCount: 0,
      };
      existing.high += row.highCount;
      existing.medium += row.mediumCount;
      existing.low += row.lowCount;
      existing.total = existing.high + existing.medium + existing.low;
      existing.scanCount += 1;
      urlAgg.set(resource.id, existing);
    }
  }

  const sortByRisk = <T extends { high: number; medium: number; low: number; total: number }>(
    rows: T[]
  ): T[] =>
    [...rows].sort((a, b) => {
      if (b.high !== a.high) return b.high - a.high;
      if (b.medium !== a.medium) return b.medium - a.medium;
      return b.total - a.total;
    });

  const byRepository = sortByRisk(Array.from(repoAgg.values()));
  const byUrlTarget = sortByRisk(Array.from(urlAgg.values()));

  const byEnvironment = Array.from(envAgg.entries())
    .map(([environment, stats]) => ({
      environment,
      repositories: stats.repositories.size,
      urlTargets: stats.urlTargets.size,
      high: stats.high,
      medium: stats.medium,
      low: stats.low,
      total: stats.high + stats.medium + stats.low,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    high,
    medium,
    low,
    byTool: toolAgg,
    byRepository,
    byUrlTarget,
    byEnvironment,
    mostVulnerableRepository: byRepository[0] ?? null,
    mostVulnerableUrl: byUrlTarget[0] ?? null,
  };
}
