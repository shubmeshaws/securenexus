import { getApiBaseUrl } from '@/lib/client-settings';
import { getAuthToken } from '@/lib/api-client';
import type { SecurityScanJobView } from '@/lib/security-scan-types';

export const ACTIVE_SECURITY_SCAN_JOB_KEY = 'sn_active_security_scan_job_id';
export const SCAN_JOB_POLL_MS = 1000;

function formatApiError(body: { error?: unknown; message?: string }, status: number): string {
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  return `Request failed (${status})`;
}

async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  return fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
  });
}

export function persistActiveScanJobId(jobId: string | null): void {
  if (typeof window === 'undefined') return;
  if (jobId) {
    localStorage.setItem(ACTIVE_SECURITY_SCAN_JOB_KEY, jobId);
  } else {
    localStorage.removeItem(ACTIVE_SECURITY_SCAN_JOB_KEY);
  }
}

export function readActiveScanJobId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACTIVE_SECURITY_SCAN_JOB_KEY);
}

export async function fetchSecurityScanJobs(): Promise<SecurityScanJobView[]> {
  const res = await authFetch('/api/security/scans/jobs');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: string };
    throw new Error(formatApiError(body, res.status));
  }
  const data = (await res.json()) as { jobs: SecurityScanJobView[] };
  return data.jobs;
}

export async function fetchActiveSecurityScanJob(): Promise<SecurityScanJobView | null> {
  const res = await authFetch('/api/security/scans/jobs?active=1');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: string };
    throw new Error(formatApiError(body, res.status));
  }
  const data = (await res.json()) as { job: SecurityScanJobView | null };
  return data.job;
}

export async function fetchSecurityScanJob(jobId: string): Promise<SecurityScanJobView> {
  const res = await authFetch(`/api/security/scans/jobs/${jobId}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: string };
    throw new Error(formatApiError(body, res.status));
  }
  const data = (await res.json()) as { job: SecurityScanJobView };
  return data.job;
}

export async function startSecurityScanJob(input: {
  resourceIds: string[];
  toolIds: string[];
}): Promise<SecurityScanJobView> {
  const res = await authFetch('/api/security/scans/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    message?: string;
    job?: SecurityScanJobView;
  };

  if (res.status === 409 && body.job) {
    persistActiveScanJobId(body.job.id);
    return body.job;
  }

  if (!res.ok) {
    throw new Error(formatApiError(body, res.status));
  }

  if (!body.job) throw new Error('Scan job was not returned by the server');
  persistActiveScanJobId(body.job.id);
  return body.job;
}

export async function deleteSecurityScanJobClient(jobId: string): Promise<void> {
  const res = await authFetch(`/api/security/scans/jobs/${jobId}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: string };
    throw new Error(formatApiError(body, res.status));
  }
}

export async function rerunSecurityScanJobClient(jobId: string): Promise<SecurityScanJobView> {
  const res = await authFetch(`/api/security/scans/jobs/${jobId}/rerun`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    message?: string;
    job?: SecurityScanJobView;
  };

  if (res.status === 409 && body.job) {
    persistActiveScanJobId(body.job.id);
    return body.job;
  }

  if (!res.ok) {
    throw new Error(formatApiError(body, res.status));
  }

  if (!body.job) throw new Error('Scan job was not returned by the server');
  persistActiveScanJobId(body.job.id);
  return body.job;
}

export function isScanJobActive(job: SecurityScanJobView): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export async function waitForSecurityScanJob(
  jobId: string,
  onUpdate: (job: SecurityScanJobView) => void
): Promise<SecurityScanJobView> {
  while (true) {
    const job = await fetchSecurityScanJob(jobId);
    onUpdate(job);

    if (job.status === 'completed' || job.status === 'failed') {
      if (job.status === 'failed') {
        throw new Error(job.error ?? 'Scan failed');
      }
      persistActiveScanJobId(null);
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, SCAN_JOB_POLL_MS));
  }
}
