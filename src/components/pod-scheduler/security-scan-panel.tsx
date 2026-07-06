'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, RotateCw, ScanSearch, Trash2 } from '@/lib/icons';
import { SecurityIconButton } from '@/components/pod-scheduler/security-icon-button';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { GlassPanel, PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { cn, formatRelativeTime } from '@/lib/utils';
import {
  SECURITY_TOOL_CATEGORIES,
  availableCategoriesForResourceTypes,
  compatibleToolsForResources,
  resolveScanPairs,
  type SecurityToolCategory,
} from '@/lib/security-tools';
import type { SecurityResourceView, SecurityToolSettingView } from '@/lib/security-service';
import type { SecurityReportMode, SecurityScanJobView } from '@/lib/security-scan-types';
import {
  SCAN_JOB_POLL_MS,
  deleteSecurityScanJobClient,
  fetchActiveSecurityScanJob,
  fetchSecurityScanJobs,
  isScanJobActive,
  persistActiveScanJobId,
  readActiveScanJobId,
  rerunSecurityScanJobClient,
  startSecurityScanJob,
} from '@/lib/security-scan-client';

function ScanMultiSelect<T extends string>({
  label,
  description,
  options,
  selected,
  onChange,
  getLabel,
  getMeta,
  placeholder = 'Select…',
  disabled = false,
}: {
  label: string;
  description?: string;
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
  getLabel: (value: T) => string;
  getMeta?: (value: T) => string | undefined;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 4;
    const preferredMaxHeight = 224;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      preferredMaxHeight,
      Math.max(120, openUp ? spaceAbove : spaceBelow)
    );
    setMenuStyle({
      top: openUp ? rect.top - gap - maxHeight : rect.bottom + gap,
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const onScrollOrResize = () => updateMenuPosition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
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
    <div className="space-y-1.5" ref={containerRef}>
      <Label className="text-[11px]">{label}</Label>
      {description ? (
        <p className="text-[10px] text-muted-foreground">{description}</p>
      ) : null}
      <div>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          disabled={disabled || options.length === 0}
          onClick={() => {
            setOpen((prev) => {
              const next = !prev;
              if (next) updateMenuPosition();
              return next;
            });
          }}
          className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-background px-3 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="truncate text-foreground">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        {mounted && open && menuStyle
          ? createPortal(
              <div
                ref={menuRef}
                className="fixed z-[200] overflow-y-auto rounded-lg border border-border bg-card p-1 text-card-foreground shadow-xl ring-1 ring-border/60"
                style={{
                  top: menuStyle.top,
                  left: menuStyle.left,
                  width: menuStyle.width,
                  maxHeight: menuStyle.maxHeight,
                }}
              >
                {options.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">No options available.</p>
                ) : (
                  options.map((option) => (
                    <label
                      key={option}
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/60',
                        selected.includes(option) && 'bg-muted/80'
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.includes(option)}
                        onCheckedChange={() => toggle(option)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block">{getLabel(option)}</span>
                        {getMeta?.(option) ? (
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {getMeta(option)}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))
                )}
                {selected.length > 0 ? (
                  <button
                    type="button"
                    className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50"
                    onClick={() => onChange([])}
                  >
                    Clear selection
                  </button>
                ) : null}
              </div>,
              document.body
            )
          : null}
      </div>
    </div>
  );
}

function jobStatusBadge(status: SecurityScanJobView['status']) {
  if (status === 'completed') {
    return <Badge variant="success" className="py-0 text-[9px]">Completed</Badge>;
  }
  if (status === 'failed') {
    return <Badge variant="failed" className="py-0 text-[9px]">Failed</Badge>;
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
};

function RecentScanJobCard({
  job,
  isScanning,
  onRerun,
  onDelete,
  rerunPending,
  deletePending,
}: {
  job: SecurityScanJobView;
  isScanning: boolean;
  onRerun: () => void;
  onDelete: () => void;
  rerunPending: boolean;
  deletePending: boolean;
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
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return jobs?.some(isScanJobActive) ? SCAN_JOB_POLL_MS : false;
    },
  });

  const activeJob = useMemo(() => scanJobs.find(isScanJobActive) ?? null, [scanJobs]);
  const isScanning = Boolean(activeJob);

  useEffect(() => {
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
  }, [queryClient]);

  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed') {
      persistActiveScanJobId(null);
      queryClient.invalidateQueries({ queryKey: ['security-reports'] });
      queryClient.invalidateQueries({ queryKey: ['security-dashboard'] });
    }
    if (activeJob.status === 'failed') {
      persistActiveScanJobId(null);
    }
  }, [activeJob, queryClient]);

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
    return (
      <GlassPanel className="flex flex-col overflow-visible">
        <PanelHeader title="Scan" icon={ScanSearch} accent="emerald" />
        <div className="flex justify-center p-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </GlassPanel>
    );
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
        <div className="space-y-5 px-5 py-4">
          <ScanMultiSelect
            label="1. Select target(s)"
            description="Choose one or more registered resources or URL targets."
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

          {canPickTypes ? (
            <ScanMultiSelect
              label="2. Select scan type(s)"
              description="Pick categories such as DAST, SAST, SCA, IaC, or Secrets."
              options={availableCategories.map((row) => row.id)}
              selected={selectedCategories}
              onChange={setSelectedCategories}
              getLabel={(id) =>
                availableCategories.find((row) => row.id === id)?.label ?? id.toUpperCase()
              }
              getMeta={(id) =>
                availableCategories.find((row) => row.id === id)?.description
              }
              placeholder="Select scan type(s)"
            />
          ) : null}

          {canPickTools ? (
            <ScanMultiSelect
              label="3. Select tool(s)"
              description="Only enabled tools matching your scan types are listed."
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
          ) : null}

          {canScan ? (
            <div className="space-y-3 border-t border-border pt-4">
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
            </div>
          ) : null}

          {selectedTargetIds.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {selectedResources.map((row) => (
                <Badge key={row.id} variant="outline" className="text-[10px]">
                  {row.name}
                  <span className="ml-1 text-muted-foreground">
                    ({row.type === 'target_url' ? 'URL' : 'Repo'})
                  </span>
                </Badge>
              ))}
            </div>
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
                    onRerun={() => rerunJob.mutate(job.id)}
                    onDelete={() => setScanJobToDelete(job)}
                  />
                ))}
              </div>
            )}

            {deleteJob.isError ? (
              <p className="text-[11px] text-red-600">
                {deleteJob.error instanceof Error ? deleteJob.error.message : 'Delete failed'}
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
    </>
  );
}
