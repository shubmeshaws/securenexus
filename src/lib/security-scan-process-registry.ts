import type { ChildProcess } from 'child_process';
import { killActiveZapScanProcesses } from '@/lib/security/zap-process-cleanup';

const childrenByJob = new Map<string, Set<ChildProcess>>();

export function registerScanChild(jobId: string, child: ChildProcess): void {
  let set = childrenByJob.get(jobId);
  if (!set) {
    set = new Set();
    childrenByJob.set(jobId, set);
  }
  set.add(child);
}

export function unregisterScanChild(jobId: string, child: ChildProcess): void {
  childrenByJob.get(jobId)?.delete(child);
}

export function killScanJobProcesses(jobId: string): void {
  const children = childrenByJob.get(jobId);
  if (children?.size) {
    for (const child of Array.from(children)) {
      try {
        if (!child.killed) child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    // Escalate to SIGKILL if a tool ignores SIGTERM (common for Java/ZAP).
    setTimeout(() => {
      for (const child of Array.from(children)) {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 2000);
  }

  // ZAP forks Java outside the tracked shell child — terminate those too.
  void killActiveZapScanProcesses();
}

export function clearScanJobProcesses(jobId: string): void {
  childrenByJob.delete(jobId);
}
