'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
  type ChartOptions,
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import { GitBranch, Globe2, LayoutDashboard, Loader2, TriangleAlert } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import type { SecurityDashboardStats } from '@/lib/security-service';

ChartJS.register(ArcElement, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const CHART_HEIGHT = 220;

function StatCard({
  label,
  value,
  sublabel,
  accent,
}: {
  label: string;
  value: number | string;
  sublabel?: string;
  accent?: 'red' | 'amber' | 'blue' | 'violet' | 'emerald';
}) {
  const accentClass =
    accent === 'red'
      ? 'text-red-600 dark:text-red-400'
      : accent === 'amber'
        ? 'text-amber-600 dark:text-amber-400'
        : accent === 'blue'
          ? 'text-blue-600 dark:text-blue-400'
          : accent === 'violet'
            ? 'text-violet-600 dark:text-violet-400'
            : accent === 'emerald'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-foreground';

  return (
    <div className="rounded-xl border border-border bg-card/80 p-4">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accentClass}`}>{value}</p>
      {sublabel ? <p className="mt-1 text-[11px] text-muted-foreground">{sublabel}</p> : null}
    </div>
  );
}

function SeverityPills({
  high,
  medium,
  low,
}: {
  high: number;
  medium: number;
  low: number;
}) {
  return (
    <div className="flex flex-wrap gap-2 text-xs font-mono">
      <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-red-600 dark:text-red-400">
        H {high}
      </span>
      <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-600 dark:text-amber-400">
        M {medium}
      </span>
      <span className="rounded-md bg-blue-500/10 px-2 py-0.5 text-blue-600 dark:text-blue-400">
        L {low}
      </span>
    </div>
  );
}

function HighlightCard({
  title,
  icon: Icon,
  name,
  link,
  linkLabel,
  high,
  medium,
  low,
  total,
  emptyMessage,
}: {
  title: string;
  icon: typeof GitBranch;
  name?: string;
  link?: string;
  linkLabel?: string;
  high?: number;
  medium?: number;
  low?: number;
  total?: number;
  emptyMessage: string;
}) {
  return (
    <GlassPanel className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {!name ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-lg font-semibold text-foreground">{name}</p>
            {link ? (
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block max-w-full truncate text-xs text-sky-600 hover:underline dark:text-sky-400"
              >
                {linkLabel ?? link}
              </a>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-3xl font-bold tabular-nums text-foreground">{total ?? 0}</p>
            <SeverityPills high={high ?? 0} medium={medium ?? 0} low={low ?? 0} />
          </div>
          <p className="text-[11px] text-muted-foreground">Total findings from latest scans</p>
        </div>
      )}
    </GlassPanel>
  );
}

function FindingsTable({
  title,
  headers,
  rows,
  emptyMessage,
}: {
  title: string;
  headers: string[];
  rows: React.ReactNode[][];
  emptyMessage: string;
}) {
  return (
    <GlassPanel className="flex flex-col">
      <PanelHeader title={title} icon={TriangleAlert} accent="amber" />
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-modern w-full min-w-[560px] text-sm">
            <thead className="bg-card/95">
              <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                {headers.map((header) => (
                  <th
                    key={header}
                    className={`px-5 py-3 font-medium ${header === 'High' || header === 'Medium' || header === 'Low' || header === 'Total' ? 'text-right' : 'text-left'}`}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, index) => (
                <tr key={index} className="border-b border-border">
                  {cells.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`px-5 py-3 ${cellIndex >= cells.length - 4 ? 'text-right font-mono text-xs' : ''}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassPanel>
  );
}

export function SecurityDashboardPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['security-dashboard'],
    queryFn: () => apiFetch<{ dashboard: SecurityDashboardStats }>('/api/security/dashboard'),
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });

  const dashboard = data?.dashboard;

  const severityChart = useMemo(() => {
    if (!dashboard) return null;
    return {
      labels: dashboard.bySeverity.map((row) => row.label),
      datasets: [
        {
          data: dashboard.bySeverity.map((row) => row.count),
          backgroundColor: dashboard.bySeverity.map((row) => row.color),
          borderWidth: 0,
        },
      ],
    };
  }, [dashboard]);

  const toolChart = useMemo(() => {
    if (!dashboard?.byTool.length) return null;
    const top = dashboard.byTool.slice(0, 8);
    return {
      labels: top.map((row) => row.toolName),
      datasets: [
        {
          label: 'High',
          data: top.map((row) => row.high),
          backgroundColor: '#dc2626',
          stack: 'findings',
        },
        {
          label: 'Medium',
          data: top.map((row) => row.medium),
          backgroundColor: '#d97706',
          stack: 'findings',
        },
        {
          label: 'Low',
          data: top.map((row) => row.low),
          backgroundColor: '#2563eb',
          stack: 'findings',
        },
      ],
    };
  }, [dashboard]);

  const environmentChart = useMemo(() => {
    if (!dashboard?.byEnvironment.length) return null;
    const top = dashboard.byEnvironment.slice(0, 6);
    return {
      labels: top.map((row) => row.environment),
      datasets: [
        {
          label: 'High',
          data: top.map((row) => row.high),
          backgroundColor: '#dc2626',
          stack: 'findings',
        },
        {
          label: 'Medium',
          data: top.map((row) => row.medium),
          backgroundColor: '#d97706',
          stack: 'findings',
        },
        {
          label: 'Low',
          data: top.map((row) => row.low),
          backgroundColor: '#2563eb',
          stack: 'findings',
        },
      ],
    };
  }, [dashboard]);

  const doughnutOptions: ChartOptions<'doughnut'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
      },
    }),
    []
  );

  const barOptions: ChartOptions<'bar'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0 } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
      },
    }),
    []
  );

  if (isLoading || !dashboard) {
    return (
      <GlassPanel className="flex flex-col">
        <PanelHeader title="Dashboard" icon={LayoutDashboard} accent="emerald" />
        <div className="flex justify-center p-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </GlassPanel>
    );
  }

  const totalFindings = dashboard.totals.high + dashboard.totals.medium + dashboard.totals.low;
  const { mostVulnerableRepository, mostVulnerableUrl } = dashboard.highlights;

  const repoRows = dashboard.byRepository.map((row) => [
    <span key="name" className="font-medium text-foreground">
      {row.name}
    </span>,
    <a
      key="url"
      href={row.repoUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-[240px] truncate text-sky-600 hover:underline dark:text-sky-400"
    >
      {row.repoUrl}
    </a>,
    <span key="high" className="text-red-600">
      {row.high}
    </span>,
    <span key="medium" className="text-amber-600">
      {row.medium}
    </span>,
    <span key="low" className="text-blue-600">
      {row.low}
    </span>,
    <span key="total" className="font-semibold text-foreground">
      {row.total}
    </span>,
  ]);

  const urlRows = dashboard.byUrlTarget.map((row) => [
    <span key="name" className="font-medium text-foreground">
      {row.name}
    </span>,
    <a
      key="url"
      href={row.targetUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-[240px] truncate text-sky-600 hover:underline dark:text-sky-400"
    >
      {row.targetUrl}
    </a>,
    <span key="high" className="text-red-600">
      {row.high}
    </span>,
    <span key="medium" className="text-amber-600">
      {row.medium}
    </span>,
    <span key="low" className="text-blue-600">
      {row.low}
    </span>,
    <span key="total" className="font-semibold text-foreground">
      {row.total}
    </span>,
  ]);

  const envRows = dashboard.byEnvironment.map((row) => [
    <span key="env" className="font-medium text-foreground">
      {row.environment}
    </span>,
    <span key="repos" className="text-muted-foreground">
      {row.repositories}
    </span>,
    <span key="urls" className="text-muted-foreground">
      {row.urlTargets}
    </span>,
    <span key="high" className="text-red-600">
      {row.high}
    </span>,
    <span key="medium" className="text-amber-600">
      {row.medium}
    </span>,
    <span key="low" className="text-blue-600">
      {row.low}
    </span>,
    <span key="total" className="font-semibold text-foreground">
      {row.total}
    </span>,
  ]);

  return (
    <div className="space-y-4">
      <GlassPanel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Security overview
            </p>
            <h2 className="mt-1 text-xl font-semibold text-foreground">Vulnerability dashboard</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Aggregated from stored scan reports — latest scan per resource, broken down by tool,
              repository, URL target, and inferred environment.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <StatCard label="Total findings" value={totalFindings} accent="violet" />
            <StatCard label="Reports analyzed" value={dashboard.totals.scans} />
          </div>
        </div>
      </GlassPanel>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="High severity" value={dashboard.totals.high} accent="red" />
        <StatCard label="Medium severity" value={dashboard.totals.medium} accent="amber" />
        <StatCard label="Low severity" value={dashboard.totals.low} accent="blue" />
        <StatCard
          label="Repositories scanned"
          value={dashboard.totals.repositoriesScanned}
          accent="emerald"
        />
        <StatCard
          label="URL targets scanned"
          value={dashboard.totals.urlTargetsScanned}
          accent="emerald"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <HighlightCard
          title="Most vulnerable repository"
          icon={GitBranch}
          name={mostVulnerableRepository?.name}
          link={mostVulnerableRepository?.repoUrl}
          high={mostVulnerableRepository?.high}
          medium={mostVulnerableRepository?.medium}
          low={mostVulnerableRepository?.low}
          total={mostVulnerableRepository?.total}
          emptyMessage="No repository scan reports yet. Run a scan on a Git repository to see rankings."
        />
        <HighlightCard
          title="Most vulnerable URL"
          icon={Globe2}
          name={mostVulnerableUrl?.name}
          link={mostVulnerableUrl?.targetUrl}
          high={mostVulnerableUrl?.high}
          medium={mostVulnerableUrl?.medium}
          low={mostVulnerableUrl?.low}
          total={mostVulnerableUrl?.total}
          emptyMessage="No URL target scan reports yet. Run a DAST scan on a URL to see rankings."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <GlassPanel className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Findings by severity</h3>
          <div style={{ height: CHART_HEIGHT }}>
            {severityChart && totalFindings > 0 ? (
              <Doughnut data={severityChart} options={doughnutOptions} />
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Run scans to populate severity breakdown.
              </p>
            )}
          </div>
        </GlassPanel>

        <GlassPanel className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Findings by tool</h3>
          <div style={{ height: CHART_HEIGHT }}>
            {toolChart ? (
              <Bar data={toolChart} options={barOptions} />
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No tool scan data yet.
              </p>
            )}
          </div>
        </GlassPanel>

        <GlassPanel className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Findings by environment</h3>
          <div style={{ height: CHART_HEIGHT }}>
            {environmentChart ? (
              <Bar data={environmentChart} options={barOptions} />
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Environment labels are inferred from resource names and URLs (dev, staging, prod,
                etc.).
              </p>
            )}
          </div>
        </GlassPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <FindingsTable
          title="Vulnerabilities by repository"
          headers={['Repository', 'Git URL', 'High', 'Medium', 'Low', 'Total']}
          rows={repoRows}
          emptyMessage="No repository findings in reports yet."
        />
        <FindingsTable
          title="Vulnerabilities by URL target"
          headers={['Target', 'URL', 'High', 'Medium', 'Low', 'Total']}
          rows={urlRows}
          emptyMessage="No URL target findings in reports yet."
        />
      </div>

      {dashboard.byEnvironment.length > 0 && (
        <FindingsTable
          title="Vulnerabilities by environment"
          headers={['Environment', 'Repos', 'URLs', 'High', 'Medium', 'Low', 'Total']}
          rows={envRows}
          emptyMessage="No environment breakdown available."
        />
      )}

      {dashboard.recentScans.length > 0 && (
        <GlassPanel className="flex flex-col">
          <PanelHeader title="Recent scan reports" icon={LayoutDashboard} accent="sky" />
          <div className="overflow-x-auto">
            <table className="table-modern w-full min-w-[720px] text-sm">
              <thead className="bg-card/95">
                <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3 text-left font-medium">Report</th>
                  <th className="px-5 py-3 text-left font-medium">Resource</th>
                  <th className="px-5 py-3 text-left font-medium">Tool</th>
                  <th className="px-5 py-3 text-right font-medium">High</th>
                  <th className="px-5 py-3 text-right font-medium">Medium</th>
                  <th className="px-5 py-3 text-right font-medium">Low</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.recentScans.map((row) => (
                  <tr key={row.id} className="border-b border-border">
                    <td className="px-5 py-3 font-medium text-foreground">{row.title}</td>
                    <td className="px-5 py-3 text-muted-foreground">{row.resourceName ?? '—'}</td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {row.toolNames.length > 1 ? row.toolNames.join(', ') : row.toolName}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-red-600">
                      {row.highCount}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-amber-600">
                      {row.mediumCount}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-blue-600">
                      {row.lowCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
