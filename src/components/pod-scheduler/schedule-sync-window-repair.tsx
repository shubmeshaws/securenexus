'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from '@/lib/icons';
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

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ScheduleSyncWindowRepair() {
  const [repairing, setRepairing] = useState(false);
  const [result, setResult] = useState<SyncWindowReconcileResult | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [schedulesScanned, setSchedulesScanned] = useState<number | null>(null);
  const pollAbortRef = useRef(false);

  useEffect(() => {
    return () => {
      pollAbortRef.current = true;
    };
  }, []);

  async function pollUntilDone(startedAt: number) {
    while (!pollAbortRef.current) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        throw new Error('Repair is still running on the server. Check logs and try again in a minute.');
      }

      const job = await apiFetch<SyncWindowReconcileJobState>('/api/schedules/reconcile-sync-windows');
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
  }

  async function runRepair() {
    pollAbortRef.current = false;
    setRepairing(true);
    setJobError(null);
    setResult(null);
    setSchedulesScanned(null);

    try {
      const startedAt = Date.now();
      await apiFetch<SyncWindowReconcileJobState>('/api/schedules/reconcile-sync-windows', {
        method: 'POST',
      });
      const data = await pollUntilDone(startedAt);
      setResult(data);
    } catch (err) {
      setJobError(err instanceof Error ? err.message : 'Repair failed');
    } finally {
      setRepairing(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={runRepair} disabled={repairing}>
        {repairing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppIcon icon={ShieldCheck} size="sm" />
        )}
        Repair sync blocks
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
    </>
  );
}
