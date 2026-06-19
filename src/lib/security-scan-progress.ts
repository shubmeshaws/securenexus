export interface ScanProgressUpdate {
  type: 'progress';
  progress: number;
  message: string;
  pairIndex: number;
  pairTotal: number;
  resourceId?: string;
  toolId?: string;
}

export type ScanProgressCallback = (update: ScanProgressUpdate) => void;

export function computeScanProgress(
  pairIndex: number,
  pairTotal: number,
  stagePercent: number
): number {
  if (pairTotal <= 0) return 100;
  const perPair = 100 / pairTotal;
  const clampedStage = Math.min(100, Math.max(0, stagePercent));
  const value = pairIndex * perPair + (clampedStage / 100) * perPair;
  if (value <= 0) return 1;
  return Math.min(100, Math.round(value));
}

export function emitScanProgress(
  onProgress: ScanProgressCallback | undefined,
  pairIndex: number,
  pairTotal: number,
  stagePercent: number,
  message: string,
  meta?: { resourceId?: string; toolId?: string }
): void {
  if (!onProgress) return;
  onProgress({
    type: 'progress',
    progress: computeScanProgress(pairIndex, pairTotal, stagePercent),
    message,
    pairIndex: pairIndex + 1,
    pairTotal,
    ...meta,
  });
}
