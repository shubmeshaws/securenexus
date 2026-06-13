import http from 'http';
import https from 'https';
import {
  getArgoCDInstanceConfig,
  listEnabledArgoCDInstances,
  type ArgoCDInstanceConfig,
} from '@/lib/argocd-instances';
import { getArgoCDConfig, normalizeArgoCDServer } from '@/lib/settings';

export interface ArgoCDHealth {
  reachable: boolean;
  message?: string;
}

export interface ArgoCDTestResult {
  ok: boolean;
  message: string;
  appCount?: number;
  clusters?: string[];
  server?: string;
}

export interface ArgoCDAppSummary {
  name: string;
  namespace: string;
  cluster: string;
  syncStatus: 'Synced' | 'OutOfSync' | 'Unknown' | 'Progressing';
  healthStatus: string;
  syncPolicy: 'automated' | 'none';
  lastSyncedAt: string | null;
  destinationNamespace: string;
  instanceId: string;
  instanceName: string;
}

export interface ArgoCDAppDetail extends ArgoCDAppSummary {
  revision: string | null;
  conditions: { type: string; message: string }[];
}

export interface ArgoCDConnectionConfig {
  server: string;
  token: string;
  insecureTls?: boolean;
}

const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

async function argoFetch(
  url: string,
  options: RequestInit & { insecureTls?: boolean; timeoutMs?: number } = {}
): Promise<Response> {
  const { insecureTls = false, timeoutMs = 15000, method = 'GET', headers, body } = options;
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const agent = isHttps && insecureTls ? insecureHttpsAgent : undefined;

  const headerRecord: Record<string, string> = {};
  if (headers) {
    const h = headers instanceof Headers ? headers : new Headers(headers);
    h.forEach((value, key) => {
      headerRecord[key] = value;
    });
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: headerRecord,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve(
            new Response(responseBody, {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? '',
              headers: res.headers as HeadersInit,
            })
          );
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);

    if (body) {
      req.write(typeof body === 'string' ? body : String(body));
    }
    req.end();
  });
}

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return 'ArgoCD unreachable';
  if (err.message.includes('certificate') || err.message.includes('UNABLE_TO_VERIFY')) {
    return 'TLS certificate verification failed — enable "Skip TLS verify" for self-signed certs';
  }
  if (err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED')) {
    return 'Cannot reach ArgoCD server — check URL and network';
  }
  return err.message;
}

export async function testArgoCDConnection(
  config: ArgoCDConnectionConfig
): Promise<ArgoCDTestResult> {
  const server = normalizeArgoCDServer(config.server);
  const token = config.token.trim();

  if (!server) {
    return { ok: false, message: 'ArgoCD server URL is required' };
  }
  if (!token) {
    return { ok: false, message: 'ArgoCD API token is required' };
  }

  try {
    const res = await argoFetch(`${server}/api/v1/applications`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      insecureTls: config.insecureTls,
      timeoutMs: 12_000,
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Authentication failed (${res.status}) — check your API token` };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        message: `ArgoCD returned ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`,
      };
    }

    const data = (await res.json()) as { items?: Record<string, unknown>[] };
    const items = data.items ?? [];
    const clusters = Array.from(
      new Set(
        items.map((item) => {
          const spec = item.spec as Record<string, unknown> | undefined;
          const destination = spec?.destination as Record<string, string> | undefined;
          return destination?.name ?? destination?.server ?? 'unknown';
        })
      )
    );

    return {
      ok: true,
      message: `Connected — ${items.length} application${items.length !== 1 ? 's' : ''} found`,
      appCount: items.length,
      clusters,
      server,
    };
  } catch (err) {
    return { ok: false, message: formatFetchError(err) };
  }
}

function mapSyncStatus(status?: string): ArgoCDAppSummary['syncStatus'] {
  switch (status) {
    case 'Synced':
      return 'Synced';
    case 'OutOfSync':
      return 'OutOfSync';
    case 'Progressing':
      return 'Progressing';
    default:
      return 'Unknown';
  }
}

function mapApp(
  raw: Record<string, unknown>,
  instance: Pick<ArgoCDInstanceConfig, 'id' | 'name'>
): ArgoCDAppSummary {
  const metadata = raw.metadata as Record<string, string> | undefined;
  const spec = raw.spec as Record<string, unknown> | undefined;
  const status = raw.status as Record<string, unknown> | undefined;
  const syncPolicy = spec?.syncPolicy as Record<string, unknown> | undefined;
  const destination = spec?.destination as Record<string, string> | undefined;
  const sync = status?.sync as Record<string, unknown> | undefined;
  const health = status?.health as Record<string, string> | undefined;
  const hasAutomated = Boolean(syncPolicy?.automated);

  return {
    name: metadata?.name ?? 'unknown',
    namespace: metadata?.namespace ?? 'argocd',
    cluster: destination?.name ?? destination?.server ?? 'in-cluster',
    syncStatus: mapSyncStatus(sync?.status as string | undefined),
    healthStatus: health?.status ?? 'Unknown',
    syncPolicy: hasAutomated ? 'automated' : 'none',
    lastSyncedAt: (sync?.syncedAt as string) ?? null,
    destinationNamespace: destination?.namespace ?? 'default',
    instanceId: instance.id,
    instanceName: instance.name,
  };
}

class InstanceArgoCDClient {
  constructor(private readonly instance: ArgoCDInstanceConfig) {}

  private get baseUrl() {
    return `${this.instance.serverUrl}/api/v1`;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.instance.token}`,
      'Content-Type': 'application/json',
    };
  }

  async listApplications(): Promise<ArgoCDAppSummary[]> {
    const res = await argoFetch(`${this.baseUrl}/applications`, {
      headers: this.headers,
      insecureTls: this.instance.insecureTls,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to list ArgoCD apps (${this.instance.name}): ${res.status} ${text}`);
    }
    const data = (await res.json()) as { items?: Record<string, unknown>[] };
    return (data.items ?? []).map((item) => mapApp(item, this.instance));
  }

  async getApplication(appName: string): Promise<ArgoCDAppDetail> {
    const res = await argoFetch(`${this.baseUrl}/applications/${encodeURIComponent(appName)}`, {
      headers: this.headers,
      insecureTls: this.instance.insecureTls,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get ArgoCD app ${appName}: ${res.status} ${text}`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const summary = mapApp(raw, this.instance);
    const status = raw.status as Record<string, unknown> | undefined;
    const sync = status?.sync as Record<string, unknown> | undefined;
    const conditions = (status?.conditions as { type: string; message: string }[]) ?? [];
    return {
      ...summary,
      revision: (sync?.revision as string) ?? null,
      conditions,
    };
  }

  async updateSyncPolicy(appName: string, syncPolicy: 'automated' | 'none'): Promise<void> {
    const app = await this.getApplicationRaw(appName);
    const spec = (app.spec as Record<string, unknown>) ?? {};
    if (syncPolicy === 'automated') {
      spec.syncPolicy = { automated: { prune: true, selfHeal: true } };
    } else {
      spec.syncPolicy = {};
    }
    const res = await argoFetch(`${this.baseUrl}/applications/${encodeURIComponent(appName)}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({ ...app, spec }),
      insecureTls: this.instance.insecureTls,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to update sync policy: ${res.status} ${text}`);
    }
  }

  async triggerSync(appName: string): Promise<void> {
    const res = await argoFetch(`${this.baseUrl}/applications/${encodeURIComponent(appName)}/sync`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ prune: false }),
      insecureTls: this.instance.insecureTls,
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to trigger sync: ${res.status} ${text}`);
    }
  }

  private async getApplicationRaw(appName: string): Promise<Record<string, unknown>> {
    const res = await argoFetch(`${this.baseUrl}/applications/${encodeURIComponent(appName)}`, {
      headers: this.headers,
      insecureTls: this.instance.insecureTls,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get ArgoCD app: ${res.status} ${text}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }
}

async function resolveInstances(): Promise<ArgoCDInstanceConfig[]> {
  const instances = await listEnabledArgoCDInstances();
  if (instances.length > 0) return instances;

  const legacy = await getArgoCDConfig();
  if (legacy.server && legacy.token) {
    return [
      {
        id: 'legacy',
        name: 'Default',
        serverUrl: legacy.server,
        token: legacy.token,
        insecureTls: legacy.insecureTls,
        enabled: true,
        clusterNames: [],
      },
    ];
  }
  return [];
}

function clientFor(instance: ArgoCDInstanceConfig) {
  return new InstanceArgoCDClient(instance);
}

async function resolveInstanceForApp(
  appName: string,
  instanceId?: string
): Promise<{ instance: ArgoCDInstanceConfig; client: InstanceArgoCDClient }> {
  if (instanceId) {
    const instance = await getArgoCDInstanceConfig(instanceId);
    if (!instance) throw new Error('ArgoCD instance not found');
    return { instance, client: clientFor(instance) };
  }

  const instances = await resolveInstances();
  for (const instance of instances) {
    const client = clientFor(instance);
    try {
      await client.getApplication(appName);
      return { instance, client };
    } catch {
      // try next instance
    }
  }
  throw new Error(`ArgoCD application "${appName}" not found on any configured instance`);
}

class MultiArgoCDClient {
  async checkHealth(): Promise<ArgoCDHealth> {
    const instances = await resolveInstances();
    if (!instances.length) {
      return { reachable: false, message: 'No ArgoCD instances configured' };
    }

    const results = await Promise.all(
      instances.map((instance) =>
        testArgoCDConnection({
          server: instance.serverUrl,
          token: instance.token,
          insecureTls: instance.insecureTls,
        })
      )
    );

    const ok = results.some((r) => r.ok);
    if (ok) return { reachable: true };

    return {
      reachable: false,
      message: results.map((r) => r.message).join('; '),
    };
  }

  async listApplications(): Promise<ArgoCDAppSummary[]> {
    const instances = await resolveInstances();
    if (!instances.length) {
      throw new Error('No ArgoCD instances configured. Add them in Admin → Settings.');
    }

    const apps: ArgoCDAppSummary[] = [];
    const errors: string[] = [];

    for (const instance of instances) {
      try {
        const listed = await clientFor(instance).listApplications();
        apps.push(...listed);
      } catch (err) {
        errors.push(
          `${instance.name}: ${err instanceof Error ? err.message : 'unreachable'}`
        );
      }
    }

    if (!apps.length) {
      throw new Error(errors.join('; ') || 'All ArgoCD instances unreachable');
    }

    return apps;
  }

  async getApplication(appName: string, instanceId?: string): Promise<ArgoCDAppDetail> {
    const { client } = await resolveInstanceForApp(appName, instanceId);
    return client.getApplication(appName);
  }

  async updateSyncPolicy(
    appName: string,
    syncPolicy: 'automated' | 'none',
    instanceId?: string
  ): Promise<void> {
    const { client } = await resolveInstanceForApp(appName, instanceId);
    return client.updateSyncPolicy(appName, syncPolicy);
  }

  async triggerSync(appName: string, instanceId?: string): Promise<void> {
    const { client } = await resolveInstanceForApp(appName, instanceId);
    return client.triggerSync(appName);
  }

  async login(username: string, password: string): Promise<{ token: string }> {
    const instances = await resolveInstances();
    const instance = instances[0];
    if (!instance?.serverUrl) throw new Error('ArgoCD server is not configured');
    const res = await argoFetch(`${instance.serverUrl}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      insecureTls: instance.insecureTls,
    });
    if (!res.ok) throw new Error('ArgoCD login failed');
    return res.json() as Promise<{ token: string }>;
  }
}

export const argocdClient = new MultiArgoCDClient();
export default argocdClient;

export function appMatchesK8sCluster(app: ArgoCDAppSummary, k8sCluster: string): boolean {
  const target = k8sCluster.toLowerCase();
  const appCluster = app.cluster.toLowerCase();
  return (
    appCluster === target ||
    target.includes(appCluster) ||
    appCluster.includes(target)
  );
}
