import { spawn } from 'child_process';
import {
  registerScanChild,
  unregisterScanChild,
} from './security-scan-process-registry';
import { isScanJobCancelRequested, ScanCancelledError } from './security-scan-cancel';

export function throwIfScanJobCancelled(scanJobId?: string): void {
  if (scanJobId && isScanJobCancelRequested(scanJobId)) {
    throw new ScanCancelledError();
  }
}

export interface ExecForScanOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

export async function execForScanJob(
  scanJobId: string | undefined,
  command: string,
  args: string[],
  options: ExecForScanOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  throwIfScanJobCancelled(scanJobId);

  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
  const timeout = options.timeout ?? 15 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
    });

    if (scanJobId) registerScanChild(scanJobId, child);

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (scanJobId) unregisterScanChild(scanJobId, child);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new Error(`Command timed out after ${timeout}ms`)));
    }, timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) {
        child.kill('SIGTERM');
        finish(() => reject(new Error('maxBuffer exceeded')));
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > maxBuffer) {
        child.kill('SIGTERM');
        finish(() => reject(new Error('maxBuffer exceeded')));
        return;
      }
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish(() => reject(err));
    });

    child.on('close', (code) => {
      if (scanJobId && isScanJobCancelRequested(scanJobId)) {
        finish(() => reject(new ScanCancelledError()));
        return;
      }

      if (code === 0) {
        finish(() => resolve({ stdout, stderr }));
        return;
      }

      const err = new Error(
        `Command failed: ${command} ${args.join(' ')} (exit ${code ?? 'unknown'})`
      ) as Error & { code?: number | null; stdout?: string; stderr?: string };
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      finish(() => reject(err));
    });
  });
}

export async function execShellForScanJob(
  scanJobId: string | undefined,
  command: string,
  options: ExecForScanOptions = {}
): Promise<string> {
  const { stdout, stderr } = await execForScanJob(scanJobId, 'sh', ['-c', command], options);
  return `${stdout}\n${stderr}`.trim();
}
