/**
 * Global cap on concurrent schedule executions (across overlapping cron ticks).
 * I/O-bound work (K8s / ArgoCD) — ~4 parallel ops per vCPU is a sensible default.
 *
 * Override: SCHEDULE_CONCURRENCY=8  (minimum clamp: 4 = ~1 vCPU at full utilisation)
 */
function resolveScheduleConcurrency(): number {
  const fromEnv = Number(process.env.SCHEDULE_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv >= 4) {
    return Math.min(Math.floor(fromEnv), 32);
  }
  // Default: 3 vCPU × 4 parallel I/O ops (tuned for batch midnight runs)
  return 12;
}

export const SCHEDULE_EXECUTION_CONCURRENCY = resolveScheduleConcurrency();

let activeCount = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeCount < SCHEDULE_EXECUTION_CONCURRENCY) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(() => {
      activeCount++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next();
}

/** Run schedule work under the global concurrency pool. */
export async function runInSchedulePool<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

export function schedulePoolStats(): { active: number; limit: number; queued: number } {
  return {
    active: activeCount,
    limit: SCHEDULE_EXECUTION_CONCURRENCY,
    queued: waitQueue.length,
  };
}

/** Parallel K8s scale/read ops inside one namespace schedule. */
export function resolveWorkloadOpConcurrency(): number {
  const fromEnv = Number(process.env.WORKLOAD_OP_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv >= 2) {
    return Math.min(Math.floor(fromEnv), 24);
  }
  return Math.max(8, SCHEDULE_EXECUTION_CONCURRENCY + 4);
}

/** Parallel Argo CD API calls (sync policy / deny windows) inside one schedule. */
export function resolveArgoOpConcurrency(): number {
  const fromEnv = Number(process.env.ARGO_OP_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv >= 2) {
    return Math.min(Math.floor(fromEnv), 16);
  }
  return 6;
}
