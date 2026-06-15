'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileUp, Fingerprint, Loader2, PiggyBank, TrendingDown } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch, getAuthToken } from '@/lib/api-client';
import { getApiBaseUrl } from '@/lib/client-settings';
import { PageHeader, GlassPanel, StatCard } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatTimestampIST, formatSignedUsd, formatUsd, parseClusterDisplay, parseDateInputEndIST, parseDateInputStartIST } from '@/lib/utils';
import { cn } from '@/lib/utils';
import {
  RESOURCE_AUDIT_TYPES,
  RESOURCE_TYPE_LABELS,
  shortRevisionSha,
  type ResourceAuditType,
} from '@/lib/resource-audit-types';
import {
  formatContributorActivity,
  formatFilterDateRangeLabel,
  formatResourceCostDisplay,
  isGitSyncResourceType,
} from '@/lib/resource-audit-display';
import {
  formatGroupedCostDisplay,
  formatGroupedResourceLabel,
  getResourceChangeLines,
  type ResourceChangeDetail,
  type ResourceChangeLine,
} from '@/lib/resource-audit-grouping';
import {
  applicationNameFromRow,
  deploymentLabelFromRow,
  valuesFileLabelFromRow,
  valuesFilePathFromRow,
} from '@/lib/helm-values-path';

export const RESOURCE_AUDIT_POLL_INTERVAL = 60_000;

interface AuditRow {
  id: string;
  argocdApp: string;
  cluster: string;
  environment: string;
  namespace: string;
  workload: string;
  containerName: string;
  resourceType: ResourceAuditType;
  oldValue: string;
  newValue: string;
  revisionSha: string;
  branchName: string | null;
  podCount: number | null;
  authorName: string;
  authorEmail: string | null;
  commitMessage: string | null;
  syncedAt: string;
  estimatedCostImpactPerDay: number | null;
  changes?: ResourceChangeDetail[];
}

interface ResourceAuditDataWindow {
  dataAvailableFrom: string;
  dataAvailableFromLabel: string;
  retentionLabel: string;
  dataStartDate: string;
  retentionAmount: number;
  retentionUnit: 'weeks' | 'months' | 'years';
}

interface AuditResponse {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  totalCostImpact: number;
  filterOptions: {
    clusters: string[];
    namespaces: string[];
    applications: string[];
    authors: { name: string; email: string | null }[];
    resourceTypes: ResourceAuditType[];
    dataWindow?: ResourceAuditDataWindow;
  };
}

interface SummaryResponse {
  summary: {
    totalCostImpact: number;
    totalChanges: number;
    gitSyncCount: number;
    resourceChangeCount: number;
    podsAddedTotal: number;
    podsRemovedTotal: number;
    dataWindow?: ResourceAuditDataWindow;
    topContributor: {
      authorName: string;
      authorEmail: string | null;
      commits: number;
      resourceIncreases: number;
      totalCostImpact: number;
      gitSyncs: number;
      resourceChanges: number;
      podsAdded: number;
      podsRemoved: number;
    } | null;
  };
}

function formatDataAvailableLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function MultiSelectFilter<T extends string>({
  label,
  options,
  selected,
  onChange,
  getLabel,
  placeholder = 'All',
}: {
  label: string;
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
  getLabel: (value: T) => string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? getLabel(selected[0])
        : `${selected.length} selected`;

  function toggle(value: T) {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
    );
  }

  return (
    <div className="relative space-y-1" ref={ref}>
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-background px-2 text-left text-xs"
      >
        <span className="truncate text-foreground">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-lg">
          {options.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
            >
              <Checkbox
                checked={selected.includes(option)}
                onCheckedChange={() => toggle(option)}
              />
              <span>{getLabel(option)}</span>
            </label>
          ))}
          {selected.length > 0 ? (
            <button
              type="button"
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50"
              onClick={() => onChange([])}
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function resourceLabel(row: AuditRow): string {
  return formatGroupedResourceLabel(row);
}

function ClusterAuditCell({ cluster }: { cluster: string }) {
  const { clusterName, accountId } = parseClusterDisplay(cluster);
  return (
    <div className="min-w-[7rem]">
      <p className="font-mono text-xs text-foreground">{clusterName}</p>
      {accountId ? (
        <p className="font-mono text-[10px] text-muted-foreground">{accountId}</p>
      ) : null}
    </div>
  );
}

function costDirection(value: number | null): 'up' | 'down' | 'neutral' {
  if (value == null || value === 0) return 'neutral';
  return value > 0 ? 'up' : 'down';
}

function truncateMessage(message: string, max = 48): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max).trim()}…`;
}

function isGitSyncRow(row: AuditRow): boolean {
  return isGitSyncResourceType(row.resourceType);
}

function formatCostForRow(row: AuditRow): string {
  if (row.changes?.length) return formatGroupedCostDisplay(row);
  return formatResourceCostDisplay(row);
}

function oldNewColorClass(direction: 'up' | 'down' | 'neutral'): string {
  if (direction === 'up') return 'text-red-600 dark:text-red-400';
  if (direction === 'down') return 'text-emerald-600 dark:text-emerald-400';
  return 'text-foreground';
}

function OldNewValue({
  line,
  direction,
  showLabel,
}: {
  line: ResourceChangeLine;
  direction: 'up' | 'down' | 'neutral';
  showLabel: boolean;
}) {
  const newColor = oldNewColorClass(direction);
  return (
    <span className="whitespace-nowrap">
      {showLabel ? (
        <span className="text-muted-foreground">{line.label} </span>
      ) : null}
      <span className="text-muted-foreground">{line.oldValue}</span>
      <span className="text-muted-foreground"> → </span>
      <span className={newColor}>{line.newValue}</span>
    </span>
  );
}

function OldNewCell({
  row,
  direction,
  expanded,
}: {
  row: AuditRow;
  direction: 'up' | 'down' | 'neutral';
  expanded: boolean;
}) {
  const lines = getResourceChangeLines(row);
  if (!lines.length) {
    return <span className="text-muted-foreground">—</span>;
  }

  if (lines.length === 1) {
    return (
      <div className="font-mono text-xs">
        <OldNewValue line={lines[0]} direction={direction} showLabel={false} />
      </div>
    );
  }

  const rest = lines.length - 1;

  return (
    <Tooltip open={expanded ? false : undefined}>
      <TooltipTrigger asChild>
        <div
          className="font-mono text-xs"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <OldNewValue line={lines[0]} direction={direction} showLabel />
          <p className="mt-0.5 text-[10px] font-sans text-muted-foreground">
            +{rest} more · hover or click row for detail
          </p>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" align="start" className="max-w-sm space-y-1.5 p-2.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
          All changes
        </p>
        {lines.map((line, i) => (
          <div key={i} className="font-mono text-xs">
            <OldNewValue line={line} direction={direction} showLabel />
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function ResourceChangesDetail({ row }: { row: AuditRow }) {
  const lines = getResourceChangeLines(row);
  if (!lines.length) return null;

  return (
    <div className="md:col-span-2">
      <p className="mb-2 font-medium text-foreground">Resource changes</p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="border-b border-border bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Field</th>
              <th className="px-3 py-1.5 text-left font-medium">Old</th>
              <th className="px-3 py-1.5 text-left font-medium">New</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-1.5 font-medium text-foreground">{line.label}</td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{line.oldValue}</td>
                <td className="px-3 py-1.5 font-mono text-foreground">{line.newValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ResourceAuditContent() {
  const [cluster, setCluster] = useState('');
  const [namespace, setNamespace] = useState('');
  const [application, setApplication] = useState('');
  const [author, setAuthor] = useState('');
  const [resourceTypes, setResourceTypes] = useState<ResourceAuditType[]>([]);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const filterQueryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (cluster) p.set('cluster', cluster);
    if (namespace) p.set('namespace', namespace);
    if (application) p.set('argocdApp', application);
    if (author) p.set('author', author);
    if (fromDate) p.set('fromDate', parseDateInputStartIST(fromDate).toISOString());
    if (toDate) p.set('toDate', parseDateInputEndIST(toDate).toISOString());
    if (resourceTypes.length) p.set('resourceType', resourceTypes.join(','));
    return p.toString();
  }, [cluster, namespace, application, author, fromDate, toDate, resourceTypes]);

  const queryParams = useMemo(() => {
    const p = new URLSearchParams(filterQueryParams);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    return p.toString();
  }, [filterQueryParams, page, pageSize]);

  const { data: summaryData, isLoading: summaryLoading, isFetching: summaryFetching } = useQuery({
    queryKey: ['resource-audit-summary', filterQueryParams],
    queryFn: () => apiFetch<SummaryResponse>(`/api/resource-audit/summary?${filterQueryParams}`),
    refetchInterval: RESOURCE_AUDIT_POLL_INTERVAL,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['resource-audit', queryParams],
    queryFn: () => apiFetch<AuditResponse>(`/api/resource-audit?${queryParams}`),
    refetchInterval: RESOURCE_AUDIT_POLL_INTERVAL,
  });

  const summary = summaryData?.summary;
  const summaryPending = summaryLoading || (summaryFetching && !summaryData);
  const rows = data?.rows ?? [];
  const filterOptions = data?.filterOptions;

  const dateRangeLabel = useMemo(() => {
    if (fromDate || toDate) return formatFilterDateRangeLabel(fromDate, toDate);
    const window = summary?.dataWindow ?? filterOptions?.dataWindow;
    if (window?.dataAvailableFromLabel) {
      return `since ${formatDataAvailableLabel(window.dataAvailableFromLabel)}`;
    }
    return 'All time';
  }, [fromDate, toDate, summary, filterOptions]);

  const dataWindow = summary?.dataWindow ?? filterOptions?.dataWindow;
  const dataAvailabilityText = dataWindow
    ? `Data available from ${formatDataAvailableLabel(dataWindow.dataAvailableFromLabel)} (${dataWindow.retentionLabel} retention)`
    : null;

  const exportFilters: Record<string, string> = {};
  if (cluster) exportFilters.cluster = cluster;
  if (namespace) exportFilters.namespace = namespace;
  if (application) exportFilters.argocdApp = application;
  if (author) exportFilters.author = author;
  if (fromDate) exportFilters.fromDate = parseDateInputStartIST(fromDate).toISOString();
  if (toDate) exportFilters.toDate = parseDateInputEndIST(toDate).toISOString();
  if (resourceTypes.length) exportFilters.resourceType = resourceTypes.join(',');

  async function downloadExport() {
    setExporting(true);
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const params = new URLSearchParams(exportFilters);
      const res = await fetch(
        `${getApiBaseUrl()}/api/resource-audit/export?${params.toString()}`,
        { credentials: 'include', headers }
      );
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `resource-change-audit-${stamp}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className="space-y-5">
      <PageHeader
        title="Resource changes"
        description={
          dataAvailabilityText ??
          'CPU, memory, and replica changes from helm-charts git commits in Bitbucket (author, branch, commit, values file).'
        }
        action={
          <Button size="sm" variant="outline" onClick={downloadExport} disabled={exporting}>
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <AppIcon icon={FileUp} size="sm" />
            )}
            Export CSV
          </Button>
        }
      />

      {summaryPending ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-blue-500/50" />
        </div>
      ) : (
        <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-3">
          <StatCard
            label={`Total cost impact · ${dateRangeLabel}`}
            value={formatSignedUsd(summary?.totalCostImpact ?? 0)}
            icon={PiggyBank}
            accent={
              summary && summary.totalCostImpact > 0
                ? 'amber'
                : summary && summary.totalCostImpact < 0
                  ? 'emerald'
                  : 'emerald'
            }
            trend={
              summary && summary.totalCostImpact > 0
                ? [
                    summary.resourceChangeCount > 0
                      ? `${summary.resourceChangeCount} resource change${summary.resourceChangeCount !== 1 ? 's' : ''}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                : summary && summary.totalCostImpact < 0
                  ? `${summary.resourceChangeCount} change${summary.resourceChangeCount !== 1 ? 's' : ''} · net savings`
                  : summary && summary.resourceChangeCount > 0
                    ? `${summary.resourceChangeCount} change${summary.resourceChangeCount !== 1 ? 's' : ''} · no net cost`
                    : 'No resource cost in range'
            }
          />
          <StatCard
            label={`Changes · ${dateRangeLabel}`}
            value={summary?.totalChanges ?? 0}
            icon={Fingerprint}
            accent="blue"
            trend={
              summary
                ? [
                    summary.gitSyncCount > 0 ? `${summary.gitSyncCount} app up` : null,
                    summary.resourceChangeCount > 0
                      ? `${summary.resourceChangeCount} resource`
                      : null,
                    summary.podsAddedTotal > 0 ? `+${summary.podsAddedTotal} pods` : null,
                    summary.podsRemovedTotal > 0 ? `−${summary.podsRemovedTotal} pods` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No changes in range'
                : undefined
            }
          />
          <StatCard
            label="Top contributor"
            value={summary?.topContributor ? summary.topContributor.authorName : '—'}
            icon={TrendingDown}
            accent="violet"
            trend={
              summary?.topContributor
                ? formatContributorActivity(summary.topContributor)
                : undefined
            }
          />
        </div>
      )}

      <GlassPanel className="space-y-4 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Cluster</Label>
            <select
              className="flex h-9 w-full rounded-lg border border-border bg-background px-2 text-xs"
              value={cluster}
              onChange={(e) => {
                setCluster(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All clusters</option>
              {(filterOptions?.clusters ?? []).filter(Boolean).map((c) => {
                const { clusterName, accountId } = parseClusterDisplay(c);
                return (
                  <option key={c} value={c}>
                    {accountId ? `${clusterName} (${accountId})` : clusterName}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Namespace</Label>
            <select
              className="flex h-9 w-full rounded-lg border border-border bg-background px-2 text-xs"
              value={namespace}
              onChange={(e) => {
                setNamespace(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All namespaces</option>
              {(filterOptions?.namespaces ?? []).filter(Boolean).map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Application name</Label>
            <select
              className="flex h-9 w-full rounded-lg border border-border bg-background px-2 text-xs"
              value={application}
              onChange={(e) => {
                setApplication(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All applications</option>
              {(filterOptions?.applications ?? []).filter(Boolean).map((app) => (
                <option key={app} value={app}>
                  {app}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Author</Label>
            <select
              className="flex h-9 w-full rounded-lg border border-border bg-background px-2 text-xs"
              value={author}
              onChange={(e) => {
                setAuthor(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All authors</option>
              {(filterOptions?.authors ?? []).map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <MultiSelectFilter
            label="Resource type"
            options={RESOURCE_AUDIT_TYPES}
            selected={resourceTypes}
            onChange={(next) => {
              setResourceTypes(next);
              setPage(1);
            }}
            getLabel={(type) => RESOURCE_TYPE_LABELS[type]}
            placeholder="All resource types"
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">From</Label>
            <Input
              type="date"
              className="h-9 w-[9.5rem] text-xs"
              value={fromDate}
              min={dataWindow?.dataAvailableFromLabel}
              max={toDate || undefined}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">To</Label>
            <Input
              type="date"
              className="h-9 w-[9.5rem] text-xs"
              value={toDate}
              min={fromDate || dataWindow?.dataAvailableFromLabel}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
            />
          </div>
          {(fromDate || toDate) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 text-xs text-muted-foreground"
              onClick={() => {
                setFromDate('');
                setToDate('');
                setPage(1);
              }}
            >
              Clear dates
            </Button>
          )}
        </div>
      </GlassPanel>

      <GlassPanel>
        {isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
          </div>
        ) : isError ? (
          <div className="p-8 text-center text-sm text-red-600 dark:text-red-400">
            Failed to load resource changes
            {error instanceof Error && error.message ? `: ${error.message}` : ''}
          </div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm table-modern">
              <thead>
                <tr className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="w-8 px-3 py-3" />
                  <th className="px-3 py-3 text-left font-medium">Git sync time</th>
                  <th className="px-3 py-3 text-left font-medium">Cluster</th>
                  <th className="px-3 py-3 text-left font-medium">Application name</th>
                  <th className="px-3 py-3 text-left font-medium">Branch</th>
                  <th className="px-3 py-3 text-left font-medium">Commit</th>
                  <th className="px-3 py-3 text-left font-medium">Author</th>
                  <th className="px-3 py-3 text-left font-medium">Git comment</th>
                  <th className="px-3 py-3 text-left font-medium">Resource</th>
                  <th className="px-3 py-3 text-left font-medium">Old → New</th>
                  <th className="px-3 py-3 text-left font-medium">Cost/day</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-muted-foreground">
                      {`No changes in the selected date range${
                            cluster || namespace || application || author || resourceTypes.length
                              ? ' for the current filters'
                              : ''
                          }. Widen the date range or adjust filters.`}
                    </td>
                  </tr>
                )}
                {rows.map((row) => {
                  const expanded = expandedId === row.id;
                  const impact =
                    row.estimatedCostImpactPerDay != null
                      ? Number(row.estimatedCostImpactPerDay)
                      : null;
                  const direction = costDirection(impact);
                  const gitSync = isGitSyncRow(row);

                  return (
                    <Fragment key={row.id}>
                      <tr
                        className="cursor-pointer border-b border-border hover:bg-muted/30"
                        onClick={() => setExpandedId(expanded ? null : row.id)}
                      >
                        <td className="px-3 py-3 text-muted-foreground">
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs">
                          {formatTimestampIST(row.syncedAt)}
                        </td>
                        <td className="px-3 py-3">
                          <ClusterAuditCell cluster={row.cluster} />
                        </td>
                        <td className="px-3 py-3 text-xs font-medium">
                          {applicationNameFromRow(row)}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs">{row.branchName ?? '—'}</td>
                        <td className="px-3 py-3 font-mono text-xs" title={row.revisionSha}>
                          {shortRevisionSha(row.revisionSha)}
                        </td>
                        <td className="px-3 py-3 text-xs">{row.authorName}</td>
                        <td
                          className="max-w-[200px] truncate px-3 py-3 text-xs text-muted-foreground"
                          title={row.commitMessage ?? undefined}
                        >
                          {row.commitMessage ? truncateMessage(row.commitMessage) : '—'}
                        </td>
                        <td className="px-3 py-3 text-xs">{resourceLabel(row)}</td>
                        <td className="px-3 py-3 font-mono text-xs">
                          <OldNewCell row={row} direction={direction} expanded={expanded} />
                        </td>
                        <td className="px-3 py-3 text-xs font-medium">
                          <span
                            className={cn(
                              gitSync &&
                                row.estimatedCostImpactPerDay == null &&
                                'text-muted-foreground',
                              gitSync &&
                                row.estimatedCostImpactPerDay != null &&
                                'text-foreground',
                              !gitSync &&
                                direction === 'up' &&
                                'text-red-600 dark:text-red-400',
                              !gitSync &&
                                direction === 'down' &&
                                'text-emerald-600 dark:text-emerald-400',
                              !gitSync && direction === 'neutral' && 'text-muted-foreground'
                            )}
                          >
                            {formatCostForRow(row)}
                          </span>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b border-border bg-muted/20">
                          <td colSpan={11} className="px-5 py-3 text-xs text-muted-foreground">
                            <div className="grid gap-2 md:grid-cols-2">
                              {gitSync ? (
                                <p className="md:col-span-2">
                                  <span className="font-medium text-foreground">App up:</span>{' '}
                                  Application synced to git with no CPU, memory, or replica changes
                                  in manifests.
                                  {row.podCount != null ? (
                                    <>
                                      {' '}
                                      Running with{' '}
                                      <span className="font-mono">{row.podCount}</span> pod
                                      {row.podCount !== 1 ? 's' : ''}.
                                    </>
                                  ) : null}
                                </p>
                              ) : null}
                              <p>
                                <span className="font-medium text-foreground">Values file:</span>{' '}
                                {valuesFileLabelFromRow(row)}
                              </p>
                              {valuesFilePathFromRow(row) ? (
                                <p className="md:col-span-2">
                                  <span className="font-medium text-foreground">Values path:</span>{' '}
                                  <span className="font-mono">{valuesFilePathFromRow(row)}</span>
                                </p>
                              ) : null}
                              <p>
                                <span className="font-medium text-foreground">Namespace:</span>{' '}
                                {row.namespace}
                              </p>
                              <p>
                                <span className="font-medium text-foreground">Deployment:</span>{' '}
                                {deploymentLabelFromRow(row)}
                              </p>
                              <p>
                                <span className="font-medium text-foreground">Environment:</span>{' '}
                                {row.environment}
                              </p>
                              <p>
                                <span className="font-medium text-foreground">Full revision:</span>{' '}
                                <span className="font-mono">{row.revisionSha}</span>
                              </p>
                              {row.authorEmail ? (
                                <p>
                                  <span className="font-medium text-foreground">Author email:</span>{' '}
                                  {row.authorEmail}
                                </p>
                              ) : null}
                              {!gitSync && getResourceChangeLines(row).length > 0 ? (
                                <ResourceChangesDetail row={row} />
                              ) : null}
                              {row.commitMessage ? (
                                <p className="md:col-span-2">
                                  <span className="font-medium text-foreground">Commit message:</span>{' '}
                                  {row.commitMessage}
                                </p>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {(data.page - 1) * data.pageSize + 1}–
              {Math.min(data.page * data.pageSize, data.total)} of {data.total} change
              {data.total !== 1 ? 's' : ''} in range
              {data.totalPages > 1 ? ` · page ${data.page} of ${data.totalPages}` : ''}
              {' · '}
              filtered impact{' '}
              <Badge variant="secondary" className="ml-1 font-mono text-[10px]">
                {formatSignedUsd(data.totalCostImpact)}
              </Badge>
            </p>
            {data.totalPages > 1 ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="px-1 text-xs text-muted-foreground">
                  Page {data.page} of {data.totalPages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </GlassPanel>
    </div>
    </TooltipProvider>
  );
}
