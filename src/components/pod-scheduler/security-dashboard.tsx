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
import { LayoutDashboard, Loader2 } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import type { SecurityDashboardStats } from '@/lib/security-service';

ChartJS.register(ArcElement, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const CHART_HEIGHT = 220;

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'red' | 'amber' | 'blue' | 'violet';
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
            : 'text-foreground';

  return (
    <div className="rounded-xl border border-border bg-card/80 p-4">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accentClass}`}>{value}</p>
    </div>
  );
}

export function SecurityDashboardPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['security-dashboard'],
    queryFn: () => apiFetch<{ dashboard: SecurityDashboardStats }>('/api/security/dashboard'),
    refetchInterval: 60_000,
  });

  const dashboard = data?.dashboard;

  const severityChart = useMemo(() => {
    if (!dashboard) return null;
    const labels = dashboard.bySeverity.map((row) => row.label);
    const values = dashboard.bySeverity.map((row) => row.count);
    const colors = dashboard.bySeverity.map((row) => row.color);
    return {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
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

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total scans" value={dashboard.totals.scans} accent="violet" />
        <StatCard label="Enabled resources" value={dashboard.totals.enabledResources} />
        <StatCard label="Enabled tools" value={dashboard.totals.enabledTools} />
        <StatCard label="Total findings" value={totalFindings} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="High severity" value={dashboard.totals.high} accent="red" />
        <StatCard label="Medium severity" value={dashboard.totals.medium} accent="amber" />
        <StatCard label="Low severity" value={dashboard.totals.low} accent="blue" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
      </div>

      {dashboard.recentScans.length > 0 && (
        <GlassPanel className="flex flex-col">
          <PanelHeader title="Recent scans" icon={LayoutDashboard} accent="sky" />
          <div className="overflow-x-auto">
            <table className="table-modern w-full min-w-[640px] text-sm">
              <thead className="bg-card/95">
                <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3 text-left font-medium">Report</th>
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
                    <td className="px-5 py-3 text-muted-foreground">{row.toolName}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-red-600">{row.highCount}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-amber-600">
                      {row.mediumCount}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-blue-600">{row.lowCount}</td>
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
