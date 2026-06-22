'use client';

import { useState } from 'react';
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

export function ScheduleSyncWindowRepair() {
  const [repairing, setRepairing] = useState(false);
  const [result, setResult] = useState<SyncWindowReconcileResult | null>(null);

  async function runRepair() {
    setRepairing(true);
    try {
      const data = await apiFetch<SyncWindowReconcileResult>(
        '/api/schedules/reconcile-sync-windows',
        { method: 'POST' }
      );
      setResult(data);
    } catch (err) {
      setResult({
        schedulesProcessed: 0,
        scheduleAppsUpdated: 0,
        instantRunsProcessed: 0,
        instantAppsUpdated: 0,
        errors: [err instanceof Error ? err.message : 'Repair failed'],
      });
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

      <Dialog open={result !== null} onOpenChange={(open) => !open && setResult(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sync block repair</DialogTitle>
            <DialogDescription>
              Applied manual-sync deny windows to stopped schedules and active instant runs.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Schedules updated: {result?.schedulesProcessed ?? 0} ({result?.scheduleAppsUpdated ?? 0}{' '}
              app(s))
            </p>
            <p>
              Instant runs updated: {result?.instantRunsProcessed ?? 0} (
              {result?.instantAppsUpdated ?? 0} app(s))
            </p>
          </div>
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
            <Button onClick={() => setResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
