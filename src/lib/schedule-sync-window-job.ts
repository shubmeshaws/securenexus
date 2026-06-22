import {
  reconcileStoppedScheduleSyncWindows,
  type SyncWindowReconcileProgress,
  type SyncWindowReconcileResult,
} from './schedule-sync-window-reconcile';

export type SyncWindowReconcileJobState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  result: SyncWindowReconcileResult | null;
  error: string | null;
  progress: SyncWindowReconcileProgress | null;
};

let job: SyncWindowReconcileJobState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  progress: null,
};

export function getSyncWindowReconcileJob(): SyncWindowReconcileJobState {
  return job;
}

/** Returns false if a repair is already running. */
export function startSyncWindowReconcileJob(): boolean {
  if (job.running) return false;

  job = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
    progress: null,
  };

  void reconcileStoppedScheduleSyncWindows((progress) => {
    job = { ...job, progress };
  })
    .then((result) => {
      job = {
        ...job,
        running: false,
        finishedAt: new Date().toISOString(),
        result,
        error: null,
        progress: {
          schedulesTotal: result.schedulesScanned,
          schedulesDone: result.schedulesScanned,
          instantRunsTotal: result.instantRunsProcessed,
          instantRunsDone: result.instantRunsProcessed,
          phase: 'done',
        },
      };
    })
    .catch((err) => {
      job = {
        ...job,
        running: false,
        finishedAt: new Date().toISOString(),
        result: null,
        error: err instanceof Error ? err.message : 'Repair failed',
      };
    });

  return true;
}
