import { getApiBaseUrl } from '@/lib/client-settings';
import { getAuthToken } from '@/lib/api-client';
import type { ScanProgressUpdate } from '@/lib/security-scan-progress';
import type { SecurityReportView } from '@/lib/security-service';

export interface SecurityScanStreamResult {
  reports: SecurityReportView[];
  count: number;
}

function parseSseChunk(chunk: string): unknown | null {
  const dataLine = chunk
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  const payload = dataLine.startsWith('data: ') ? dataLine.slice(6) : dataLine.slice(5);
  if (!payload) return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

export async function runSecurityScanStream(
  input: { resourceIds: string[]; toolIds: string[] },
  onProgress: (update: ScanProgressUpdate) => void
): Promise<SecurityScanStreamResult> {
  const token = getAuthToken();
  const res = await fetch(`${getApiBaseUrl()}/api/security/scans/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    credentials: 'include',
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: string };
    const message =
      typeof body.message === 'string' && body.message.trim()
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : `Scan failed (${res.status})`;
    throw new Error(message);
  }

  if (!res.body) {
    throw new Error('Scan stream is not available from the server');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: SecurityScanStreamResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const event = parseSseChunk(part);
      if (!event || typeof event !== 'object') continue;

      const typed = event as {
        type?: string;
        progress?: number;
        message?: string;
        reports?: SecurityReportView[];
        count?: number;
      };

      if (typed.type === 'error') {
        throw new Error(
          typeof (event as { message?: string }).message === 'string'
            ? (event as { message: string }).message
            : 'Scan failed'
        );
      }

      if (typed.type === 'complete') {
        result = {
          reports: typed.reports ?? [],
          count: typed.count ?? typed.reports?.length ?? 0,
        };
        continue;
      }

      if (typed.type === 'progress' && typeof typed.progress === 'number') {
        onProgress(event as ScanProgressUpdate);
      }
    }
  }

  if (!result) {
    throw new Error('Scan finished without a completion event');
  }

  return result;
}
