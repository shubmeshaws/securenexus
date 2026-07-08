import {
  authenticateSonarqubeWithToken,
  isSonarqubeAuthenticated,
  readSonarqubeUsername,
} from '@/lib/security/sonarqube-runner';
import { invalidateSecurityToolSettingsCache } from '@/lib/security-service';
import { invalidateToolRuntimeCache } from '@/lib/security/tool-runtime';

export type SonarqubeAuthJobState = {
  authenticated: boolean;
  username: string | null;
  serverUrl: string | null;
  error: string | null;
  phase: string | null;
};

let job: SonarqubeAuthJobState = {
  authenticated: false,
  username: null,
  serverUrl: null,
  error: null,
  phase: null,
};

function invalidateSonarqubeCaches(): void {
  invalidateSecurityToolSettingsCache();
  invalidateToolRuntimeCache('sonarqube');
}

export function getSonarqubeAuthJob(): SonarqubeAuthJobState {
  return job;
}

export async function refreshSonarqubeAuthStatus(): Promise<SonarqubeAuthJobState> {
  const authenticated = await isSonarqubeAuthenticated();
  const username = authenticated ? await readSonarqubeUsername() : null;
  const { readSonarqubeConfig } = await import('@/lib/security/sonarqube-config');
  const config = authenticated ? await readSonarqubeConfig() : null;

  job = {
    authenticated,
    username,
    serverUrl: config?.serverUrl ?? null,
    error: authenticated ? null : job.error,
    phase: authenticated ? 'SonarQube authenticated successfully.' : job.phase,
  };

  if (authenticated) {
    invalidateSonarqubeCaches();
  }

  return job;
}

export async function authenticateSonarqubeWithTokenJob(
  serverUrl: string,
  token: string
): Promise<SonarqubeAuthJobState> {
  job = {
    authenticated: false,
    username: null,
    serverUrl: null,
    error: null,
    phase: 'Validating SonarQube token…',
  };

  try {
    const username = await authenticateSonarqubeWithToken(serverUrl, token);
    const { readSonarqubeConfig } = await import('@/lib/security/sonarqube-config');
    const config = await readSonarqubeConfig();
    invalidateSonarqubeCaches();
    job = {
      authenticated: true,
      username,
      serverUrl: config?.serverUrl ?? serverUrl,
      error: null,
      phase: 'SonarQube authenticated successfully.',
    };
  } catch (err) {
    job = {
      authenticated: false,
      username: null,
      serverUrl: null,
      error: err instanceof Error ? err.message : 'Failed to authenticate SonarQube.',
      phase: null,
    };
  }

  return job;
}
