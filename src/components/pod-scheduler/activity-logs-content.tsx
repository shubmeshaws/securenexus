'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ListFilter, Loader2, ScanSearch, FileUp, ScrollText } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { apiFetch, getAuthToken, type ActivityLogEntry } from '@/lib/api-client';
import { getApiBaseUrl } from '@/lib/client-settings';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
import { PageHeader, GlassPanel, UserAvatar } from '@/components/pod-scheduler/ui-primitives';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatRelativeTime, formatTimestampIST, parseClusterDisplay } from '@/lib/utils';
import { activityActorLabel } from '@/lib/alert-display';
import { formatWorkloadKeyLabel } from '@/lib/workload-utils';
import { SHUTDOWN_ACTIONS, STARTUP_ACTIONS } from '@/lib/dashboard-schedule-actions';
import { cn } from '@/lib/utils';

const ACTION_LABELS: Record<string, string> = {
  'sync-off': 'Sync Off',
  'sync-on': 'Sync On',
  'scale-down': 'Scale Down',
  'scale-up': 'Scale Up',
  'schedule-run': 'Schedule Run',
  'schedule-shutdown': 'Scheduled Shutdown',
  'schedule-startup': 'Scheduled Startup',
  'cluster-add': 'Cluster Added',
  'cluster-remove': 'Cluster Removed',
  'user-create': 'User Created',
  'user-update': 'User Updated',
  'user-delete': 'User Deleted',
  'password-change': 'Password Changed',
};

const ACTION_COLORS: Record<string, string> = {
  'scale-down': 'text-red-600 dark:text-red-400',
  'scale-up': 'text-emerald-600 dark:text-emerald-400',
  'sync-off': 'text-amber-600 dark:text-amber-400',
  'sync-on': 'text-sky-600 dark:text-sky-400',
  'cluster-add': 'text-blue-600 dark:text-blue-400',
  'user-create': 'text-sky-600 dark:text-sky-400',
  'password-change': 'text-muted-foreground',
};

interface ParsedDetails {
  scope?: string;
  workloads?: string[];
  count?: number;
}

function parseLogDetails(details?: string | null): ParsedDetails | null {
  if (!details) return null;
  try {
    return JSON.parse(details) as ParsedDetails;
  } catch {
    return null;
  }
}

function activityUserLabel(log: ActivityLogEntry): string {
  return activityActorLabel(log.triggeredBy, {
    userName: log.userName,
    action: log.action,
  });
}

function ActivityTargetCell({
  log,
  onShowDetails,
}: {
  log: ActivityLogEntry;
  onShowDetails: (log: ActivityLogEntry, workloads: string[]) => void;
}) {
  if (log.cluster === '—') return <span className="text-muted-foreground">—</span>;

  const parsed = parseLogDetails(log.details);
  const isNamespace = log.appName === '*' || parsed?.scope === 'namespace';
  const workloads = parsed?.workloads ?? [];
  const { clusterName } = parseClusterDisplay(log.cluster);

  if (isNamespace && workloads.length > 0) {
    return (
      <button
        type="button"
        onClick={() => onShowDetails(log, workloads)}
        className="text-left hover:underline"
      >
        <span className="text-foreground">{clusterName}</span>
        <span className="text-muted-foreground"> / </span>
        <span className="text-foreground">{log.namespace}</span>
        <p className="mt-0.5 text-[10px] text-blue-600 dark:text-blue-400">
          All workloads ({workloads.length}) · view details
        </p>
      </button>
    );
  }

  if (isNamespace) {
    return (
      <span>
        <span className="text-foreground">{clusterName}</span>
        <span className="text-muted-foreground"> / </span>
        <span className="text-foreground">{log.namespace}</span>
        <p className="mt-0.5 text-[10px] text-muted-foreground">All workloads</p>
      </span>
    );
  }

  return (
    <span>
      <span className="text-foreground">{clusterName}</span>
      <span className="text-muted-foreground"> / </span>
      <span className="text-foreground">{log.namespace}</span>
      <span className="text-muted-foreground"> / </span>
      <span className="font-medium text-foreground">{log.appName}</span>
    </span>
  );
}

export function ActivityLogsContent() {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [dateFilter, setDateFilter] = useState('');
  const [actionTypeFilter, setActionTypeFilter] = useState<'all' | 'shutdown' | 'startup'>('all');
  const [detailLog, setDetailLog] = useState<{
    log: ActivityLogEntry;
    workloads: string[];
  } | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'pdf'>('csv');
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');

  useEffect(() => {
    const date = searchParams.get('date');
    const type = searchParams.get('type');
    if (date) setDateFilter(date);
    if (type === 'shutdown' || type === 'startup') setActionTypeFilter(type);
  }, [searchParams]);

  const openExportDialog = (format: 'csv' | 'pdf') => {
    setExportFormat(format);
    setExportDialogOpen(true);
  };

  const downloadExport = async () => {
    setExporting(exportFormat);
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const params = new URLSearchParams({ format: exportFormat });
      if (exportFrom) params.set('from', new Date(exportFrom).toISOString());
      if (exportTo) params.set('to', new Date(exportTo).toISOString());
      const res = await fetch(
        `${getApiBaseUrl()}/api/schedules/activity/export?${params.toString()}`,
        { credentials: 'include', headers }
      );
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `activity-logs-${stamp}.${exportFormat}`;
      link.click();
      URL.revokeObjectURL(url);
      setExportDialogOpen(false);
    } finally {
      setExporting(null);
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['activity'],
    queryFn: () => apiFetch<{ logs: ActivityLogEntry[] }>('/api/schedules/activity'),
    refetchInterval: POLL_INTERVAL,
  });

  const logs = (data?.logs ?? []).filter((log) => {
    if (statusFilter !== 'all' && log.status !== statusFilter) return false;
    if (dateFilter) {
      const logDate = log.timestamp.slice(0, 10);
      if (logDate !== dateFilter) return false;
    }
    if (actionTypeFilter === 'shutdown' && !(SHUTDOWN_ACTIONS as readonly string[]).includes(log.action)) {
      return false;
    }
    if (actionTypeFilter === 'startup' && !(STARTUP_ACTIONS as readonly string[]).includes(log.action)) {
      return false;
    }
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      log.userName?.toLowerCase().includes(q) ||
      log.userEmail?.toLowerCase().includes(q) ||
      log.action.toLowerCase().includes(q) ||
      log.cluster.toLowerCase().includes(q) ||
      log.appName.toLowerCase().includes(q) ||
      log.message?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activity Logs"
        description="Complete audit trail with user identity, IP addresses, and action details."
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openExportDialog('csv')}
              disabled={exporting !== null}
            >
              {exporting === 'csv' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AppIcon icon={FileUp} size="sm" />
              )}
              CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openExportDialog('pdf')}
              disabled={exporting !== null}
            >
              {exporting === 'pdf' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AppIcon icon={ScrollText} size="sm" />
              )}
              PDF
            </Button>
          </div>
        }
      />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <AppIcon icon={ScanSearch} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, action, cluster..."
            className="pl-10"
          />
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/50 p-1">
          <AppIcon icon={ListFilter} size="sm" className="ml-2 text-muted-foreground" />
          {(['all', 'success', 'failed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all',
                statusFilter === s
                  ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/80 dark:bg-blue-500/20 dark:text-blue-200 dark:ring-0'
                  : 'text-zinc-600 hover:text-foreground dark:text-muted-foreground'
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {(dateFilter || actionTypeFilter !== 'all') && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Chart filter:</span>
          {dateFilter && (
            <Badge variant="secondary" className="font-normal">
              Date {dateFilter}
            </Badge>
          )}
          {actionTypeFilter !== 'all' && (
            <Badge variant="secondary" className="font-normal capitalize">
              {actionTypeFilter}s
            </Badge>
          )}
          <button
            type="button"
            className="text-blue-600 underline dark:text-blue-400"
            onClick={() => {
              setDateFilter('');
              setActionTypeFilter('all');
            }}
          >
            Clear
          </button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{logs.length} entries · timestamps in IST</p>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
        </div>
      ) : (
        <GlassPanel className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm table-modern">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left px-5 py-3.5 font-medium">Timestamp (IST)</th>
                  <th className="text-left px-5 py-3.5 font-medium">User</th>
                  <th className="text-left px-5 py-3.5 font-medium">Action</th>
                  <th className="text-left px-5 py-3.5 font-medium">Target</th>
                  <th className="text-left px-5 py-3.5 font-medium">IP</th>
                  <th className="text-left px-5 py-3.5 font-medium">Status</th>
                  <th className="text-left px-5 py-3.5 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-sm text-muted-foreground">
                      No activity recorded
                    </td>
                  </tr>
                )}
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-border">
                    <td className="whitespace-nowrap px-5 py-4">
                      <p className="text-xs font-medium text-foreground">
                        {formatTimestampIST(log.timestamp)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {formatRelativeTime(log.timestamp)}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2.5">
                        <UserAvatar name={activityUserLabel(log)} size="sm" />
                        <div>
                          <p className="text-xs font-semibold text-foreground">
                            {activityUserLabel(log)}
                          </p>
                          {log.userEmail && (
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{log.userEmail}</p>
                          )}
                          {log.userRole && (
                            <Badge variant="manual" className="mt-1 text-[9px] py-0 px-1.5">{log.userRole}</Badge>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className={cn('text-xs font-medium', ACTION_COLORS[log.action] ?? 'text-muted-foreground')}>
                        {ACTION_LABELS[log.action] ?? log.action}
                      </span>
                    </td>
                    <td className="px-5 py-4 font-mono text-[11px] text-muted-foreground">
                      <ActivityTargetCell
                        log={log}
                        onShowDetails={(l, workloads) => setDetailLog({ log: l, workloads })}
                      />
                    </td>
                    <td className="px-5 py-4 font-mono text-[11px] text-foreground">{log.ipAddress ?? '—'}</td>
                    <td className="px-5 py-4">
                      <Badge variant={log.status === 'success' ? 'success' : 'failed'}>{log.status}</Badge>
                    </td>
                    <td className="px-5 py-4 max-w-[200px]">
                      <p className="truncate text-xs text-muted-foreground">{log.message ?? '—'}</p>
                      {log.details && !parseLogDetails(log.details)?.workloads?.length && (
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80">{log.details}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      )}

      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export activity logs</DialogTitle>
            <DialogDescription>
              Choose an optional date/time range. Leave blank to export all logs within the retention window.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="export-from">From</Label>
              <Input
                id="export-from"
                type="datetime-local"
                value={exportFrom}
                onChange={(e) => setExportFrom(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-to">To</Label>
              <Input
                id="export-to"
                type="datetime-local"
                value={exportTo}
                onChange={(e) => setExportTo(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setExportDialogOpen(false)} disabled={exporting !== null}>
              Cancel
            </Button>
            <Button onClick={downloadExport} disabled={exporting !== null}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Download {exportFormat.toUpperCase()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detailLog !== null} onOpenChange={() => setDetailLog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Workload targets</DialogTitle>
            <DialogDescription>
              {detailLog && (
                <>
                  {parseClusterDisplay(detailLog.log.cluster).clusterName} / {detailLog.log.namespace}
                  {detailLog.log.message ? ` — ${detailLog.log.message}` : ''}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {detailLog && (
            <ul className="max-h-64 space-y-2 overflow-y-auto scrollbar-thin">
              {detailLog.workloads.map((wk) => (
                <li
                  key={wk}
                  className="rounded-lg border border-border bg-secondary/30 px-3 py-2 font-mono text-xs text-foreground"
                >
                  {formatWorkloadKeyLabel(wk)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setDetailLog(null)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
