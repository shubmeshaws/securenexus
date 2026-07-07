import { execFile } from 'child_process';
import { promisify } from 'util';
import { toolPathEnv } from '@/lib/security/tool-path-env';

const execFileAsync = promisify(execFile);

export const SNYK_AUTH_URL = 'https://snyk.io/login';

export async function isSnykAvailable(): Promise<boolean> {
  try {
    await execFileAsync('snyk', ['--version'], { timeout: 8000, env: toolPathEnv() });
    return true;
  } catch {
    return false;
  }
}

export async function isSnykAuthenticated(): Promise<boolean> {
  if (!(await isSnykAvailable())) return false;
  try {
    const { stdout } = await execFileAsync('snyk', ['whoami'], {
      timeout: 15000,
      env: toolPathEnv(),
    });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

export async function readSnykVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('snyk', ['--version'], {
      timeout: 8000,
      env: toolPathEnv(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
