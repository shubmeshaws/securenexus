import { execFile, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { toolPathEnv } from '@/lib/security/tool-path-env';

const execFileAsync = promisify(execFile);

const SNYK_CONFIG_ROOT = path.join(process.cwd(), '.securenexus', 'snyk-config');
const OAUTH_URL_PATTERN = /https:\/\/app\.snyk\.io\/oauth2\/authorize[^\s]+/;

export function snykEnv(): NodeJS.ProcessEnv {
  return {
    ...toolPathEnv(),
    XDG_CONFIG_HOME: SNYK_CONFIG_ROOT,
    SNYK_CFG_ORG: process.env.SNYK_CFG_ORG,
  };
}

export async function ensureSnykConfigDir(): Promise<void> {
  await fs.mkdir(SNYK_CONFIG_ROOT, { recursive: true });
}

export async function isSnykAvailable(): Promise<boolean> {
  try {
    await execFileAsync('snyk', ['--version'], { timeout: 8000, env: snykEnv() });
    return true;
  } catch {
    return false;
  }
}

export async function hasSnykApiToken(): Promise<boolean> {
  if (process.env.SNYK_TOKEN?.trim()) return true;
  try {
    const { stdout } = await execFileAsync('snyk', ['config', 'get', 'api'], {
      timeout: 10000,
      env: snykEnv(),
    });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

export async function isSnykAuthenticated(): Promise<boolean> {
  if (!(await isSnykAvailable())) return false;
  if (!(await hasSnykApiToken())) return false;
  try {
    const { stdout } = await execFileAsync('snyk', ['whoami'], {
      timeout: 20000,
      env: snykEnv(),
    });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

export async function readSnykWhoami(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('snyk', ['whoami'], {
      timeout: 20000,
      env: snykEnv(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readSnykVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('snyk', ['--version'], {
      timeout: 8000,
      env: snykEnv(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function authenticateSnykWithToken(token: string): Promise<string> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Snyk API token is required.');

  await ensureSnykConfigDir();
  await execFileAsync('snyk', ['auth', trimmed], {
    timeout: 45000,
    env: snykEnv(),
    maxBuffer: 4 * 1024 * 1024,
  });

  const whoami = await readSnykWhoami();
  if (!whoami) {
    throw new Error('Snyk rejected the token. Generate a new token from your Snyk account settings.');
  }
  return whoami;
}

export function extractSnykOAuthUrl(output: string): string | null {
  const match = output.match(OAUTH_URL_PATTERN);
  return match?.[0] ?? null;
}

export type SnykAuthStartResult = {
  authUrl: string;
  message: string;
};

export async function startSnykBrowserAuth(
  onOutput?: (chunk: string) => void
): Promise<{ result: SnykAuthStartResult; child: import('child_process').ChildProcess }> {
  await ensureSnykConfigDir();

  return new Promise((resolve, reject) => {
    const child = spawn('snyk', ['auth'], {
      env: snykEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let combined = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Timed out waiting for Snyk to provide an authentication URL.'));
    }, 30_000);

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      combined += text;
      onOutput?.(text);
      const authUrl = extractSnykOAuthUrl(combined);
      if (authUrl && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          result: {
            authUrl,
            message:
              'Open the Snyk login page, sign in, then return here and click Check auth status.',
          },
          child,
        });
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        reject(new Error('Snyk authentication completed before a login URL was captured.'));
        return;
      }
      const authUrl = extractSnykOAuthUrl(combined);
      if (authUrl) {
        resolve({
          result: {
            authUrl,
            message:
              'Open the Snyk login page, sign in, then return here and click Check auth status.',
          },
          child,
        });
        return;
      }
      reject(
        new Error(
          combined.trim() ||
            'Snyk auth failed to start. Use an API token from your Snyk account instead.'
        )
      );
    });
  });
}
