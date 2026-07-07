import { spawn, type ChildProcess } from 'child_process';
import {
  authenticateSnykWithToken,
  isSnykAuthenticated,
  readSnykWhoami,
  startSnykBrowserAuth,
} from '@/lib/security/snyk-runner';
import { invalidateSecurityToolSettingsCache } from '@/lib/security-service';
import { invalidateToolRuntimeCache } from '@/lib/security/tool-runtime';

export type SnykAuthJobState = {
  running: boolean;
  phase: string | null;
  authUrl: string | null;
  authenticated: boolean;
  username: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

let job: SnykAuthJobState = {
  running: false,
  phase: null,
  authUrl: null,
  authenticated: false,
  username: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

let authChild: ChildProcess | null = null;

function invalidateSnykCaches(): void {
  invalidateSecurityToolSettingsCache();
  invalidateToolRuntimeCache('snyk');
}

export function getSnykAuthJob(): SnykAuthJobState {
  return job;
}

export function resetSnykAuthJob(): void {
  if (authChild && !authChild.killed) {
    authChild.kill('SIGTERM');
  }
  authChild = null;
  job = {
    running: false,
    phase: null,
    authUrl: null,
    authenticated: false,
    username: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

export async function refreshSnykAuthStatus(): Promise<SnykAuthJobState> {
  const authenticated = await isSnykAuthenticated();
  const username = authenticated ? await readSnykWhoami() : null;
  job = {
    ...job,
    running: false,
    authenticated,
    username,
    error: authenticated ? null : job.error,
    phase: authenticated ? 'Snyk authenticated successfully.' : job.phase,
  };
  if (authenticated) {
    invalidateSnykCaches();
  }
  return job;
}

function watchAuthChild(child: ChildProcess): void {
  authChild = child;
  child.on('close', () => {
    authChild = null;
    void refreshSnykAuthStatus().then((status) => {
      job = {
        ...status,
        phase: status.authenticated
          ? 'Snyk authenticated successfully.'
          : 'Snyk login window closed before authentication completed.',
        finishedAt: new Date().toISOString(),
      };
    });
  });
}

export function startSnykBrowserAuthJob(): boolean {
  if (job.running) return false;

  job = {
    running: true,
    phase: 'Starting Snyk authentication…',
    authUrl: null,
    authenticated: false,
    username: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  void startSnykBrowserAuth((chunk) => {
    if (job.running && chunk.trim()) {
      job = { ...job, phase: 'Waiting for Snyk login in your browser…' };
    }
  })
    .then(({ result, child }) => {
      watchAuthChild(child);
      job = {
        ...job,
        running: false,
        phase: result.message,
        authUrl: result.authUrl,
        finishedAt: new Date().toISOString(),
      };
    })
    .catch((err) => {
      job = {
        ...job,
        running: false,
        phase: null,
        error: err instanceof Error ? err.message : 'Snyk authentication failed to start.',
        finishedAt: new Date().toISOString(),
      };
    });

  return true;
}

export async function authenticateSnykWithTokenJob(token: string): Promise<SnykAuthJobState> {
  job = {
    running: true,
    phase: 'Saving Snyk API token…',
    authUrl: null,
    authenticated: false,
    username: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  try {
    const username = await authenticateSnykWithToken(token);
    invalidateSnykCaches();
    job = {
      running: false,
      phase: 'Snyk authenticated successfully.',
      authUrl: null,
      authenticated: true,
      username,
      error: null,
      startedAt: job.startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    job = {
      running: false,
      phase: null,
      authUrl: null,
      authenticated: false,
      username: null,
      error: err instanceof Error ? err.message : 'Failed to authenticate Snyk.',
      startedAt: job.startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  return job;
}
