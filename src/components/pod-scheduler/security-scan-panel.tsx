'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleStop, Eye, Loader2, RotateCw, ScanSearch, Trash2 } from '@/lib/icons';
import { ScanMultiSelect } from '@/components/pod-scheduler/scan-multi-select';
import { SecurityIconButton } from '@/components/pod-scheduler/security-icon-button';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn, formatRelativeTime } from '@/lib/utils';
import {
  SECURITY_TOOL_CATEGORIES,
  availableCategoriesForResourceTypes,
  compatibleToolsForResources,
  resolveScanPairs,
  type SecurityToolCategory,
} from '@/lib/security-tools';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { SecurityResourceView, SecurityToolSettingView } from '@/lib/security-service';
import type { SecurityReportMode, SecurityScanJobReportView, SecurityScanJobView } from '@/lib/security-scan-types';
import {
  SCAN_JOB_POLL_MS,
  cancelSecurityScanJobClient,
  deleteSecurityScanJobClient,
  fetchActiveSecurityScanJob,
  fetchSecurityScanJobs,
  isScanJobActive,
  persistActiveScanJobId,
  readActiveScanJobId,
  rerunSecurityScanJobClient,
  startSecurityScanJob,
} from '@/lib/security-scan-client';

function ScanStepSection({
  step,
  title,
  description,
  children,
  disabled = false,
}: {
  step: number;
  title: string;
  description?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border/80 bg-card/50 p-4 shadow-sm',
        disabled && 'pointer-events-none opacity-45'
      )}
    >
      <div className="mb-3 flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-xs font-bold text-emerald-700 dark:text-emerald-400">
          {step}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function jobStatusBadge(status: SecurityScanJobView['status']) {
  if (status === 'completed') {
    return <Badge variant="success" className="py-0 text-[9px]">Completed</Badge>;
  }
  if (status === 'failed') {
    return <Badge variant="failed" className="py-0 text-[9px]">Failed</Badge>;
  }
  if (status === 'cancelled') {
    return <Badge variant="outline" className="py-0 text-[9px] text-muted-foreground">Cancelled</Badge>;
  }
  if (status === 'running') {
    return (
      <Badge variant="progressing" className="gap-1 py-0 text-[9px]">
        <Loader2 className="h-2 w-2 animate-spin" />
        Running
      </Badge>
    );
  }
  return <Badge variant="manual" className="py-0 text-[9px]">Queued</Badge>;
}

const JOB_STATUS_ACCENT: Record<SecurityScanJobView['status'], string> = {
  queued: 'bg-muted-foreground/40',
  running: 'bg-sky-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-muted-foreground/50',
};

function RecentScanJobCard({
  job,
  isScanning,
  onRerun,
  onDelete,
  onCancel,
  onViewReport,
  rerunPending,
  deletePending,
  cancelPending,
}: {
  job: SecurityScanJobView;
  isScanning: boolean;
  onRerun: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onViewReport: () => void;
  rerunPending: boolean;
  deletePending: boolean;
  cancelPending: boolean;
}) {
  const active = isScanJobActive(job);
  const targetLabel = job.resourceNames.join(', ') || '—';
  const toolLabel = job.toolNames.join(', ') || '—';

  return (
    <article
      className={cn(
        'group overflow-hidden rounded-md border border-border/80 bg-card/30 transition-colors hover:bg-card/60',
        active && 'border-sky-500/30 bg-sky-500/[0.03]'
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
        <div className={cn('h-6 w-0.5 shrink-0 rounded-full', JOB_STATUS_ACCENT[job.status])} aria-hidden />

        <p
          className="w-16 shrink-0 truncate text-[10px] text-muted-foreground"
          title={formatScanTime(job.createdAt)}
        >
          {formatRelativeTime(job.createdAt)}
        </p>

        <div className="min-w-0 flex-1 truncate text-[11px]" title={`${targetLabel} · ${toolLabel}`}>
          <span className="font-medium text-foreground">{targetLabel}</span>
          <span className="text-muted-foreground"> · {toolLabel}</span>
          {job.status === 'failed' && job.error ? (
            <span className="text-red-600 dark:text-red-400"> · {job.error}</span>
          ) : null}
        </div>

        {active ? (
          <div className="flex w-24 shrink-0 items-center gap-1.5">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-sky-500 transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(1, Math.min(100, job.progress))}%` }}
              />
            </div>
            <span className="font-mono text-[9px] tabular-nums text-sky-600">{job.progress}%</span>
          </div>
        ) : (
          <span className="hidden shrink-0 text-[10px] tabular-nums text-muted-foreground sm:inline">
            {job.reportCount}
          </span>
        )}

        <div className="shrink-0">{jobStatusBadge(job.status)}</div>
        {job.reportMode === 'merged' && job.pairTotal > 1 ? (
          <Badge variant="outline" className="shrink-0 text-[9px]">
            Merged
          </Badge>
        ) : null}

        <div className="flex shrink-0 items-center gap-1">
          {active ? (
            <SecurityIconButton
              icon={CircleStop}
              label="Stop scan"
              tone="danger"
              disabled={cancelPending}
              loading={cancelPending}
              onClick={onCancel}
            />
          ) : null}
          {job.status === 'completed' && job.reports.length > 0 ? (
            <SecurityIconButton
              icon={Eye}
              label="View report"
              tone="emerald"
              onClick={onViewReport}
            />
          ) : null}
          <SecurityIconButton
            icon={RotateCw}
            label="Scan again"
            tone="sky"
            disabled={isScanning || rerunPending}
            loading={rerunPending}
            onClick={onRerun}
          />
          <SecurityIconButton
            icon={Trash2}
            label="Delete scan"
            tone="danger"
            disabled={active || deletePending}
            loading={deletePending}
            onClick={onDelete}
          />
        </div>
      </div>
    </article>
  );
}

function formatScanTime(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function ScanPanelSkeleton() {
  return (
    <GlassPanel className="flex flex-col overflow-visible">
      <PanelHeader title="Scan" icon={ScanSearch} accent="emerald" />
      <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
        Select targets and tools, then run a scan. Progress appears in Recent scans below.
      </p>
      <div className="space-y-4 px-5 py-4">
        {[1, 2, 3].map((step) => (
          <div
            key={step}
            className="rounded-xl border border-border/80 bg-card/50 p-4 shadow-sm animate-pulse"
          >
            <div className="mb-3 flex items-start gap-3">
              <div className="h-8 w-8 shrink-0 rounded-full bg-muted" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-32 rounded bg-muted" />
                <div className="h-3 w-full max-w-sm rounded bg-muted/70" />
              </div>
            </div>
            <div className="h-10 rounded-md bg-muted/60" />
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

export function SecurityScanPanel({
  resources,
  toolSettings,
  loading,
}: {
  resources: SecurityResourceView[];
  toolSettings: SecurityToolSettingView[];
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<SecurityToolCategory[]>([]);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [reportMode, setReportMode] = useState<SecurityReportMode>('separate');
  const [scanJobToDelete, setScanJobToDelete] = useState<SecurityScanJobView | null>(null);
  const [previewReportId, setPreviewReportId] = useState<string | null>(null);
  const [reportPickerJob, setReportPickerJob] = useState<SecurityScanJobView | null>(null);
  const resumeChecked = useRef(false);

  const enabledResources = useMemo(
    () => resources.filter((row) => row.enabled),
    [resources]
  );

  const enabledToolIds = useMemo(
    () => new Set(toolSettings.filter((row) => row.enabled).map((row) => row.toolId)),
    [toolSettings]
  );

  const selectedResources = useMemo(
    () => enabledResources.filter((row) => selectedTargetIds.includes(row.id)),
    [enabledResources, selectedTargetIds]
  );

  const targetSelectionHint = useMemo(() => {
    if (!selectedResources.length) return null;
    const onlyUrl = selectedResources.every((row) => row.type === 'target_url');
    const onlyRepo = selectedResources.every((row) => row.type === 'repository');
    if (onlyUrl) return 'URL targets support DAST scans only.';
    if (onlyRepo) return 'Repositories support SAST, SCA, IaC, and Secrets scans.';
    return 'Mixed selection: repositories and URL targets use different scan types. Tools are matched per target.';
  }, [selectedResources]);

  const availableCategories = useMemo(() => {
    if (!selectedResources.length) return [];
    const ids = availableCategoriesForResourceTypes(selectedResources.map((row) => row.type));
    return SECURITY_TOOL_CATEGORIES.filter((row) => ids.includes(row.id));
  }, [selectedResources]);

  const availableTools = useMemo(() => {
    if (!selectedResources.length || !selectedCategories.length) return [];
    return compatibleToolsForResources(
      selectedResources,
      enabledToolIds,
      selectedCategories
    );
  }, [selectedResources, selectedCategories, enabledToolIds]);

  const scanPairCount = useMemo(() => {
    if (!selectedResources.length || !selectedToolIds.length) return 0;
    return resolveScanPairs({
      resources: selectedResources,
      toolIds: selectedToolIds,
      enabledToolIds,
    }).length;
  }, [selectedResources, selectedToolIds, enabledToolIds]);

  const { data: scanJobs = [], isLoading: jobsLoading } = useQuery({
    queryKey: ['security-scan-jobs'],
    queryFn: fetchSecurityScanJobs,
    staleTime: 15_000,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return jobs?.some(isScanJobActive) ? SCAN_JOB_POLL_MS : false;
    },
  });

  const activeJob = useMemo(() => scanJobs.find(isScanJobActive) ?? null, [scanJobs]);
  const isScanning = Boolean(activeJob);

  useEffect(() => {
    if (loading) return;
    if (resumeChecked.current) return;
    resumeChecked.current = true;

    void (async () => {
      try {
        const active = await fetchActiveSecurityScanJob();
        if (active) {
          persistActiveScanJobId(active.id);
          await queryClient.invalidateQueries({ queryKey: ['security-scan-jobs'] });
          return;
        }
        if (readActiveScanJobId()) {
          persistActiveScanJobId(null);
        }
      } catch {
        // Ignore resume errors on mount.
      }
    })();
  }, [loading, queryClient]);

  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed') {
      persistActiveScanJobId(null);
      queryClient.invalidateQueries({ queryKey: ['security-reports'] });
      queryClient.invalidateQueries({ queryKey: ['security-dashboard'] });
    }
    if (activeJob.status === 'failed' || activeJob.status === 'cancelled') {
      persistActiveScanJobId(null);
    }
  }, [activeJob, queryClient]);

  const { data: previewHtml, isLoading: previewLoading } = useQuery({
    queryKey: ['security-report-preview', previewReportId],
    queryFn: async () => {
      const res = await fetch(`/api/security/reports/${previewReportId}/download?format=html`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load report');
      return res.text();
    },
    enabled: Boolean(previewReportId),
  });

  function openJobReports(job: SecurityScanJobView) {
    if (!job.reports.length) return;
    if (job.reports.length === 1) {
      setPreviewReportId(job.reports[0].id);
      return;
    }
    setReportPickerJob(job);
  }

  function openReport(report: SecurityScanJobReportView) {
    setReportPickerJob(null);
    setPreviewReportId(report.id);
  }

  useEffect(() => {
    if (!selectedResources.length) return;
    const onlyUrl = selectedResources.every((row) => row.type === 'target_url');
    const onlyRepo = selectedResources.every((row) => row.type === 'repository');
    if (onlyUrl) {
      setSelectedCategories(['dast']);
    } else if (onlyRepo) {
      setSelectedCategories((prev) => prev.filter((category) => category !== 'dast'));
    }
  }, [selectedResources]);

  useEffect(() => {
    setSelectedCategories((prev) =>
      prev.filter((id) => availableCategories.some((row) => row.id === id))
    );
  }, [availableCategories]);

  useEffect(() => {
    const allowed = new Set(availableTools.map((tool) => tool.id));
    setSelectedToolIds((prev) => prev.filter((id) => allowed.has(id)));
  }, [availableTools]);

  const runScan = useMutation({
    mutationFn: () =>
      startSecurityScanJob({
        resourceIds: selectedTargetIds,
        toolIds: selectedToolIds,
        reportMode: scanPairCount > 1 ? reportMode : 'separate',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-scan-jobs'] });
    },
  });

  const deleteJob = useMutation({
    mutationFn: (jobId: string) => deleteSecurityScanJobClient(jobId),
    onSuccess: () => {
      setScanJobToDelete(null);
      queryClient.invalidateQueries({ queryKey: ['security-scan-jobs'] });
    },
  });

  const cancelJob = useMutation({
    mutationFn: (jobId: string) => cancelSecurityScanJobClient(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-scan-jobs'] });
    },
  });

  const rerunJob = useMutation({
    mutationFn: (jobId: string) => rerunSecurityScanJobClient(jobId),
    onSuccess: (job) => {
      setSelectedTargetIds(job.resourceIds);
      setSelectedToolIds(job.toolIds);
      queryClient.invalidateQueries({ queryKey: ['security-scan-jobs'] });
    },
  });

  const canPickTypes = selectedTargetIds.length > 0;
  const canPickTools = canPickTypes && selectedCategories.length > 0;
  const canScan = canPickTools && selectedToolIds.length > 0 && scanPairCount > 0;

  if (loading) {
    return <ScanPanelSkeleton />;
  }

  return (
    <>
    <GlassPanel className="flex flex-col overflow-visible">
      <PanelHeader title="Scan" icon={ScanSearch} accent="emerald" />
      <p className="border-b border-border px-5 pb-3 text-[11px] text-muted-foreground">
        Select targets and tools, then run a scan. Progress appears in Recent scans below — refresh
        the page during a scan and it will resume automatically.
      </p>

      {!enabledResources.length ? (
        <p className="p-10 text-center text-sm text-muted-foreground">
          No enabled targets. Add a repository or URL target under Add resources first.
        </p>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <ScanStepSection
            step={1}
            title="Select targets"
            description="Choose one or more repositories or URL targets."
          >
            <ScanMultiSelect
              label=""
              options={enabledResources.map((row) => row.id)}
              selected={selectedTargetIds}
              onChange={setSelectedTargetIds}
              getLabel={(id) => enabledResources.find((row) => row.id === id)?.name ?? id}
              getMeta={(id) => {
                const row = enabledResources.find((r) => r.id === id);
                if (!row) return undefined;
                const type = row.type === 'target_url' ? 'URL target' : 'Repository';
                return `${type} · ${row.repoUrl ?? row.targetUrl ?? '—'}`;
              }}
              placeholder="Select target(s)"
            />
          </ScanStepSection>

          {canPickTypes ? (
            <ScanStepSection
              step={2}
              title="Select scan types"
              description={targetSelectionHint ?? 'Pick one or more scan categories.'}
            >
              <ScanMultiSelect
                label=""
                options={availableCategories.map((row) => row.id)}
                selected={selectedCategories}
                onChange={setSelectedCategories}
                getLabel={(id) =>
                  availableCategories.find((row) => row.id === id)?.label ?? id.toUpperCase()
                }
                getMeta={(id) => availableCategories.find((row) => row.id === id)?.description}
                placeholder="Select scan type(s)"
              />
            </ScanStepSection>
          ) : null}

          {canPickTools ? (
            <ScanStepSection
              step={3}
              title="Select tools"
              description="Only enabled tools matching your targets and scan types are listed."
            >
              <ScanMultiSelect
                label=""
                options={availableTools.map((tool) => tool.id)}
                selected={selectedToolIds}
                onChange={setSelectedToolIds}
                getLabel={(id) => availableTools.find((tool) => tool.id === id)?.name ?? id}
                getMeta={(id) => {
                  const tool = availableTools.find((row) => row.id === id);
                  if (!tool) return undefined;
                  const category = SECURITY_TOOL_CATEGORIES.find((row) => row.id === tool.category);
                  return category?.label ?? tool.category.toUpperCase();
                }}
                placeholder={
                  availableTools.length ? 'Select tool(s)' : 'Enable tools under Tools first'
                }
                disabled={!availableTools.length}
              />
            </ScanStepSection>
          ) : null}

          {canScan ? (
            <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
              {scanPairCount > 1 ? (
                <div className="space-y-2">
                  <Label className="text-[11px]">Report output</Label>
                  <div className="inline-flex rounded-lg border border-border bg-card/60 p-1">
                    <button
                      type="button"
                      onClick={() => setReportMode('separate')}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
                        reportMode === 'separate'
                          ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      Separate reports ({scanPairCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setReportMode('merged')}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
                        reportMode === 'merged'
                          ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      One merged report
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {reportMode === 'merged'
                      ? 'All scan results will be combined into a single HTML/PDF report.'
                      : 'Each tool and repository combination will produce its own report.'}
                  </p>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  className="h-9 gap-1.5"
                  disabled={isScanning || runScan.isPending}
                  onClick={() => runScan.mutate()}
                >
                  {isScanning || runScan.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ScanSearch className="h-4 w-4" />
                  )}
                  Run scan
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {scanPairCount} scan{scanPairCount === 1 ? '' : 's'} across{' '}
                  {selectedTargetIds.length} target{selectedTargetIds.length === 1 ? '' : 's'} and{' '}
                  {selectedToolIds.length} tool{selectedToolIds.length === 1 ? '' : 's'}
                  {isScanning && activeJob ? ` · ${activeJob.message ?? 'Running…'}` : ''}
                </p>
              </div>
            </section>
          ) : null}

          {runScan.isError ? (
            <p className="text-[11px] text-red-600">
              {runScan.error instanceof Error ? runScan.error.message : 'Scan failed'}
            </p>
          ) : null}

          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-foreground">Recent scans</h3>
                {scanJobs.length > 0 ? (
                  <Badge variant="outline" className="text-[9px] tabular-nums">
                    {scanJobs.length}
                  </Badge>
                ) : null}
              </div>
              <span className="text-[10px] text-muted-foreground">Last 20</span>
            </div>

            {jobsLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : scanJobs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                <ScanSearch className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" />
                <p className="text-[11px] text-muted-foreground">
                  No scans yet. Run your first scan above.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {scanJobs.map((job) => (
                  <RecentScanJobCard
                    key={job.id}
                    job={job}
                    isScanning={isScanning}
                    rerunPending={rerunJob.isPending}
                    deletePending={deleteJob.isPending && scanJobToDelete?.id === job.id}
                    cancelPending={cancelJob.isPending && cancelJob.variables === job.id}
                    onRerun={() => rerunJob.mutate(job.id)}
                    onDelete={() => setScanJobToDelete(job)}
                    onCancel={() => cancelJob.mutate(job.id)}
                    onViewReport={() => openJobReports(job)}
                  />
                ))}
              </div>
            )}

            {deleteJob.isError ? (
              <p className="text-[11px] text-red-600">
                {deleteJob.error instanceof Error ? deleteJob.error.message : 'Delete failed'}
              </p>
            ) : null}
            {cancelJob.isError ? (
              <p className="text-[11px] text-red-600">
                {cancelJob.error instanceof Error ? cancelJob.error.message : 'Stop failed'}
              </p>
            ) : null}
            {rerunJob.isError ? (
              <p className="text-[11px] text-red-600">
                {rerunJob.error instanceof Error ? rerunJob.error.message : 'Scan again failed'}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </GlassPanel>

    <ConfirmDialog
      open={scanJobToDelete !== null}
      onOpenChange={(open) => {
        if (!open && !deleteJob.isPending) setScanJobToDelete(null);
      }}
      title="Delete scan?"
      description={
        scanJobToDelete ? (
          <>
            Permanently delete this scan from{' '}
            <span className="font-medium text-foreground">
              {new Date(scanJobToDelete.createdAt).toLocaleString()}
            </span>
            ? This cannot be undone.
          </>
        ) : (
          'Permanently delete this scan?'
        )
      }
      confirmLabel="Delete scan"
      onConfirm={() => scanJobToDelete && deleteJob.mutate(scanJobToDelete.id)}
      loading={deleteJob.isPending}
    />

    <Dialog open={reportPickerJob !== null} onOpenChange={(open) => !open && setReportPickerJob(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>View report</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {reportPickerJob?.reports.map((report) => (
            <button
              key={report.id}
              type="button"
              onClick={() => openReport(report)}
              className="flex w-full items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
            >
              <Eye className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{report.title}</p>
                <p className="text-[11px] text-muted-foreground">{report.toolName}</p>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(previewReportId)} onOpenChange={(open) => !open && setPreviewReportId(null)}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <DialogTitle>Report preview</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden bg-muted/30 p-3">
          {previewLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <iframe
              title="Security report preview"
              srcDoc={previewHtml ?? ''}
              className="h-full w-full rounded-lg border border-border bg-white"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
