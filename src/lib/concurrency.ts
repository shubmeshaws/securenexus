/** Run async tasks with a fixed concurrency limit. */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const poolSize = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
}

export interface RetryOptions {
  /** Total attempts including the first try (default 4). */
  attempts?: number;
  /** Delay before the first retry (default 3000ms). */
  baseDelayMs?: number;
  /** Cap for the exponential backoff (default 60000ms). */
  maxDelayMs?: number;
  /** Backoff multiplier per attempt (default 2). */
  factor?: number;
  /** Return false to stop retrying for a given error (e.g. 404 / not-found). */
  shouldRetry?: (err: unknown) => boolean;
  /** Called before each backoff delay. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Retry an async operation with exponential backoff. Used to ride out transient
 * Kubernetes / Argo CD API failures (timeouts, throttling) that spike when many
 * schedules run at once — instead of letting a single hiccup fail the whole action.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 3000;
  const maxDelayMs = options.maxDelayMs ?? 60000;
  const factor = options.factor ?? 2;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < attempts && (options.shouldRetry?.(err) ?? true);
      if (!canRetry) break;
      const delayMs = Math.min(maxDelayMs, Math.round(baseDelayMs * factor ** (attempt - 1)));
      options.onRetry?.(err, attempt, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
