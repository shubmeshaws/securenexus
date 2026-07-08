import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CLEANUP_TIMEOUT_MS = 20_000;

async function runCleanupShell(command: string): Promise<void> {
  try {
    await execFileAsync('sh', ['-c', command], { timeout: CLEANUP_TIMEOUT_MS });
  } catch {
    // Best-effort cleanup — scan may still succeed.
  }
}

async function removeZapHomeLocks(homeDirs: string[]): Promise<void> {
  const lockNames = ['.homelock', 'lock', '.lock'];
  const uniqueDirs = Array.from(new Set(homeDirs.filter(Boolean)));

  for (const dir of uniqueDirs) {
    for (const lockName of lockNames) {
      await fs.rm(path.join(dir, lockName), { force: true }).catch(() => undefined);
    }
  }
}

async function removeStaleSecureNexusZapTempDirs(): Promise<void> {
  const tmpDir = os.tmpdir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(tmpDir);
  } catch {
    return;
  }

  const cutoffMs = Date.now() - 6 * 60 * 60 * 1000;
  await Promise.all(
    entries
      .filter((name) => name.startsWith('sn-zap-'))
      .map(async (name) => {
        const fullPath = path.join(tmpDir, name);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.mtimeMs < cutoffMs) {
            await fs.rm(fullPath, { recursive: true, force: true });
          }
        } catch {
          // ignore
        }
      })
  );
}

/** Stop orphaned ZAP processes left behind by crashed or interrupted scans. */
async function killOrphanedZapProcesses(): Promise<void> {
  await runCleanupShell(`
    pkill -TERM -f 'org\\.zaproxy\\.zap' 2>/dev/null || true
    pkill -TERM -f 'zap\\.sh.*-cmd' 2>/dev/null || true
    pkill -TERM -f '/opt/zap/zap\\.sh' 2>/dev/null || true
    sleep 2
    pkill -KILL -f 'org\\.zaproxy\\.zap' 2>/dev/null || true
    pkill -KILL -f 'zap\\.sh.*-cmd' 2>/dev/null || true
    pkill -KILL -f '/opt/zap/zap\\.sh' 2>/dev/null || true
  `);
}

/** Stop active ZAP processes (e.g. when a scan is cancelled mid-run). */
export async function killActiveZapScanProcesses(): Promise<void> {
  await killOrphanedZapProcesses();
}

export function isZapHomeDirectoryInUseError(message: string): boolean {
  return /home directory is already in use|\.homelock/i.test(message);
}

/**
 * Prepare the host for a new ZAP scan without manual intervention:
 * terminate stale ZAP processes, clear lock files, and prune old temp dirs.
 */
export async function cleanupStaleZapEnvironment(extraHomeDirs: string[] = []): Promise<void> {
  const defaultZapHome = path.join(os.homedir(), '.ZAP');
  await killOrphanedZapProcesses();
  await removeZapHomeLocks([defaultZapHome, ...extraHomeDirs]);
  await removeStaleSecureNexusZapTempDirs();
}
