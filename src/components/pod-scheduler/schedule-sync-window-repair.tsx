'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck, CircleX, Timer } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api-client';
import type { SyncWindowReconcileResult } from '@/lib/schedule-sync-window-reconcile';
import type { SyncWindowReconcileJobState } from '@/lib/schedule-sync-window-job';
import type { SyncWindowClearResult } from '@/lib/schedule-sync-window-clear';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 25 * 60 * 1000;

const NO_CACHE_FETCH: RequestInit = {
  cache: 'no-store',
  headers: {
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  },
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reconcileStatusUrl(): string {
  return `/api/schedules/reconcile-sync-windows?_=${Date.now()}`;
}

function formatProgress(job: SyncWindowReconcileJobState): string | null {
  const p = job.progress;
  if (!p || !job.running) return null;
  if (p.phase === 'schedules') {
    return `Processing schedules (${p.schedulesDone}/${p.schedulesTotal})…`;
  }
  if (p.phase === 'instant-runs') {
    return `Processing instant runs (${p.instantRunsDone}/${p.instantRunsTotal})…`;
  }
  return 'Finishing…';
}

export function ScheduleSyncWindowRepair() {
  const queryClient = useQueryClient();
  const [repairing, setRepairing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [fixingTiming, setFixingTiming] = useState(false);
  const [timingResult, setTimingResult] = useState<{
    schedulesUpdated: number;
    startupDaysCorrected: number;
  } | null>(null);
  const [timingError, setTimingError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncWindowReconcileResult | null>(null);
  const [clearResult, setClearResult] = useState<SyncWindowClearResult | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [schedulesScanned, setSchedulesScanned] = useState<number | null>(null);
  const pollAbortRef = useRef(false);

  useEffect(() => {
    return () => {
      pollAbortRef.current = true;
    };
  }, []);

  const runFixTiming = useCallback(async () => {
    setFixingTiming(true);
    setTimingError(null);
    setTimingResult(null);
    try {
      const data = await apiFetch<{
        schedulesUpdated: number;
        startupDaysCorrected: number;
      }>('/api/schedules/repair-timing', { ...NO_CACHE_FETCH, method: 'POST' });
      setTimingResult(data);
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
      await queryClient.invalidateQueries({ queryKey: ['schedules-live'] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
    } catch (err) {
      setTimingError(err instanceof Error ? err.message : 'Fix timing failed');
    } finally {
      setFixingTiming(false);
    }
  }, [queryClient]);

  const pollUntilDone = useCallback(async (startedAt: number) => {
    while (!pollAbortRef.current) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        throw new Error(
          'Repair is still running on the server (large number of schedules). Click Repair sync blocks again in a minute to pick up the result.'
        );
      }

      const job = await apiFetch<SyncWindowReconcileJobState>(
        reconcileStatusUrl(),
        NO_CACHE_FETCH
      );
      setProgressLabel(formatProgress(job));

      if (job.result) {
        setSchedulesScanned(job.result.schedulesScanned);
        return job.result;
      }
      if (job.error) {
        throw new Error(job.error);
      }
      if (!job.running) {
        throw new Error('Repair finished without a result. Check server logs.');
      }

      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('Repair cancelled');
  }, []);

  const runRepair = useCallback(async () => {
    pollAbortRef.current = false;
    setRepairing(true);
    setJobError(null);
    setResult(null);
    setSchedulesScanned(null);
    setProgressLabel(null);

    try {
      const startedAt = Date.now();
      const kickoff = await apiFetch<SyncWindowReconcileJobState>(reconcileStatusUrl(), {
        ...NO_CACHE_FETCH,
        method: 'POST',
      });
      setProgressLabel(formatProgress(kickoff));
      const data = await pollUntilDone(startedAt);
      setResult(data);
    } catch (err) {
      setJobError(err instanceof Error ? err.message : 'Repair failed');
    } finally {
      setRepairing(false);
      setProgressLabel(null);
    }
  }, [pollUntilDone]);

  const runClear = useCallback(async () => {
    setClearing(true);
    setClearError(null);
    setClearResult(null);

    try {
      const data = await apiFetch<SyncWindowClearResult>('/api/schedules/clear-sync-windows', {
        ...NO_CACHE_FETCH,
        method: 'POST',
      });
      setClearResult(data);
    } catch (err) {
      setClearError(err instanceof Error ? err.message : 'Clear failed');
    } finally {
      setClearing(false);
    }
  }, []);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={runFixTiming}
        disabled={repairing || clearing || fixingTiming}
        title="Fix stale Next Run / Startup At on existing schedules (e.g. Tuesday → Monday)"
      >
        {fixingTiming ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppIcon icon={Timer} size="sm" />
        )}
        Fix schedule timing
      </Button>
      <Button size="sm" variant="outline" onClick={runRepair} disabled={repairing || clearing || fixingTiming}>
        {repairing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppIcon icon={ShieldCheck} size="sm" />
        )}
        {repairing && progressLabel ? progressLabel : 'Repair sync blocks'}
      </Button>
      <Button size="sm" variant="outline" onClick={runClear} disabled={repairing || clearing || fixingTiming}>
        {clearing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppIcon icon={CircleX} size="sm" />
        )}
        Clear sync blocks
      </Button>

      <Dialog
        open={result !== null || jobError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResult(null);
            setJobError(null);
            setSchedulesScanned(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sync block repair</DialogTitle>
            <DialogDescription>
              {jobError
                ? 'The repair could not be completed.'
                : 'Applied manual-sync deny windows to stopped schedules and active instant runs.'}
            </DialogDescription>
          </DialogHeader>
          {jobError ? (
            <p className="text-sm text-red-500">{jobError}</p>
          ) : (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Schedules scanned: {result?.schedulesScanned ?? schedulesScanned ?? 0}</p>
              <p>
                Schedules updated: {result?.schedulesProcessed ?? 0} ({result?.scheduleAppsUpdated ?? 0}{' '}
                app(s))
              </p>
              <p>
                Instant runs updated: {result?.instantRunsProcessed ?? 0} (
                {result?.instantAppsUpdated ?? 0} app(s))
              </p>
            </div>
          )}
          {(result?.errors.length ?? 0) > 0 && (
            <ul className="max-h-40 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm">
              {result?.errors.map((error) => (
                <li key={error} className="text-muted-foreground">
                  {error}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button
              onClick={() => {
                setResult(null);
                setJobError(null);
                setSchedulesScanned(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={clearResult !== null || clearError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setClearResult(null);
            setClearError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sync block cleanup</DialogTitle>
            <DialogDescription>
              {clearError
                ? 'Could not remove SecureNexus sync blocks.'
                : 'Removed SecureNexus deny sync windows and restored automated sync where applicable.'}
            </DialogDescription>
          </DialogHeader>
          {clearError ? (
            <p className="text-sm text-red-500">{clearError}</p>
          ) : (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Argo instances processed: {clearResult?.instancesProcessed ?? 0}</p>
              <p>
                Projects updated: {clearResult?.projectsUpdated ?? 0} (scanned{' '}
                {clearResult?.projectsScanned ?? 0})
              </p>
              <p>Deny windows removed: {clearResult?.windowsRemoved ?? 0}</p>
              <p>Automated sync restored: {clearResult?.syncPoliciesRestored ?? 0} app(s)</p>
            </div>
          )}
          {(clearResult?.errors.length ?? 0) > 0 && (
            <ul className="max-h-40 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm">
              {clearResult?.errors.map((error) => (
                <li key={error} className="text-muted-foreground">
                  {error}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button
              onClick={() => {
                setClearResult(null);
                setClearError(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={timingResult !== null || timingError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTimingResult(null);
            setTimingError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Schedule timing repair</DialogTitle>
            <DialogDescription>
              {timingError
                ? 'Could not repair schedule timing.'
                : 'Updated Next Run and Startup At for existing schedules.'}
            </DialogDescription>
          </DialogHeader>
          {timingError ? (
            <p className="text-sm text-red-500">{timingError}</p>
          ) : (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Schedules updated: {timingResult?.schedulesUpdated ?? 0}</p>
              <p>
                Long-stop start day corrected (Tue → Mon):{' '}
                {timingResult?.startupDaysCorrected ?? 0}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => {
                setTimingResult(null);
                setTimingError(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
