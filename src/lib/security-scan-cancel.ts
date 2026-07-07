const cancelRequestedJobIds = new Set<string>();

export function requestScanJobCancel(jobId: string): void {
  cancelRequestedJobIds.add(jobId);
}

export function isScanJobCancelRequested(jobId: string): boolean {
  return cancelRequestedJobIds.has(jobId);
}

export function clearScanJobCancel(jobId: string): void {
  cancelRequestedJobIds.delete(jobId);
}

export class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled by user');
    this.name = 'ScanCancelledError';
  }
}
