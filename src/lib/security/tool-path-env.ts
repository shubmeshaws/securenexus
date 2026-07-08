import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function extendedToolPath(): string {
  return [
    '/opt/sonar-scanner/bin',
    path.join(process.cwd(), '.securenexus', 'sonar-scanner', 'bin'),
    path.join(process.cwd(), '.securenexus', 'bin'),
    path.join(process.cwd(), '.securenexus', 'venv-semgrep', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    process.env.PATH ?? '',
  ]
    .filter(Boolean)
    .join(':');
}

export function toolPathEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: extendedToolPath(),
  };
}

const SEMGREP_CANDIDATES = [
  path.join(process.cwd(), '.securenexus', 'bin', 'semgrep'),
  path.join(process.cwd(), '.securenexus', 'venv-semgrep', 'bin', 'semgrep'),
];

export async function resolveSemgrepBin(): Promise<string> {
  const env = toolPathEnv();
  try {
    const { stdout } = await execFileAsync('which', ['semgrep'], { env, timeout: 5000 });
    const resolved = stdout.trim().split('\n')[0]?.trim();
    if (resolved) return resolved;
  } catch {
    // fall through to known install locations
  }

  for (const candidate of SEMGREP_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    'Semgrep CLI is not installed or not on PATH. Install Semgrep from Security → Tools before running live scans.'
  );
}

export async function semgrepScanEnv(): Promise<NodeJS.ProcessEnv> {
  const semgrepBin = await resolveSemgrepBin();
  return {
    ...toolPathEnv(),
    SEMGREP_BIN: semgrepBin,
  };
}
