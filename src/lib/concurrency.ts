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
