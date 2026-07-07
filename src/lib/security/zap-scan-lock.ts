let zapScanChain: Promise<unknown> = Promise.resolve();

/** Serialize ZAP scans — only one zap.sh process at a time per SecureNexus server. */
export function withZapScanLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = zapScanChain.then(() => fn());
  zapScanChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
