/** Merge ready node count into activity log details JSON. */
export function buildShutdownActivityDetails(
  base: Record<string, unknown> | undefined,
  nodeCount: number | null
): string | undefined {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  if (nodeCount != null && nodeCount >= 0) {
    merged.nodeCount = nodeCount;
  }
  return Object.keys(merged).length > 0 ? JSON.stringify(merged) : undefined;
}

export function parseShutdownNodeCount(details: string | null | undefined): number | null {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details) as { nodeCount?: unknown; platformType?: string };
    if (parsed.platformType === 'non_eks') return null;
    if (typeof parsed.nodeCount === 'number' && parsed.nodeCount >= 0) {
      return parsed.nodeCount;
    }
  } catch {
    // ignore non-JSON details
  }
  return null;
}

export function isEksShutdownLog(details: string | null | undefined): boolean {
  if (!details) return true;
  try {
    const parsed = JSON.parse(details) as { platformType?: string };
    return parsed.platformType !== 'non_eks';
  } catch {
    return true;
  }
}
