import http from 'http';
import https from 'https';
import {
  getArgoCDInstanceConfig,
  listEnabledArgoCDInstances,
  type ArgoCDInstanceConfig,
} from '@/lib/argocd-instances';
import {
  buildNamespaceDenySyncWindow,
  buildScheduleDenySyncWindow,
  mergeNamespaceDenySyncWindow,
  mergeScheduleDenySyncWindow,
  removeScheduleDenySyncWindows,
  removeScheduleNamespaceDenyWindow,
  type ArgoSyncWindowSpec,
} from '@/lib/argocd-sync-windows';
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
  branchName: string | null;
  conditions: { type: string; message: string }[];
}

export interface ArgoCDRevisionMetadata {
  author: string;
  date: string;
  message: string;
  tags?: string[];
}

export interface ArgoCDHistoryEntry {
  revision: string;
  deployedAt: Date;
  appNamespace: string;
  branchName: string | null;
}

export interface ArgoCDManagedResourceItem {
  group: string;
  kind: string;
  namespace: string;
  name: string;
  liveState: string;
  targetState?: string;
}

export interface ArgoCDConnectionConfig {
  server: string;
  token: string;
  insecureTls?: boolean;
}

const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const APPS_LIST_CACHE_TTL_MS = 90_000;
let appsListCache: { at: number; apps: ArgoCDAppSummary[] } | null = null;

export function invalidateArgoAppsCache() {
  appsListCache = null;
}

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

  private projectLockChains = new Map<string, Promise<unknown>>();

  private runProjectLocked<T>(projectName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.projectLockChains.get(projectName) ?? Promise.resolve();
    const job = prev.catch(() => undefined).then(fn);
    this.projectLockChains.set(projectName, job);
    return job.finally(() => {
      if (this.projectLockChains.get(projectName) === job) {
        this.projectLockChains.delete(projectName);
      }
    });
  }

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
      timeoutMs: 120_000,
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
    const spec = raw.spec as Record<string, unknown> | undefined;
    const source = spec?.source as Record<string, string> | undefined;
    const status = raw.status as Record<string, unknown> | undefined;
    const sync = status?.sync as Record<string, unknown> | undefined;
    const operationState = status?.operationState as Record<string, unknown> | undefined;
    const conditions = (status?.conditions as { type: string; message: string }[]) ?? [];
    const revision =
      (sync?.revision as string) ??
      (operationState?.syncResult as Record<string, string> | undefined)?.revision ??
      null;
    const lastSyncedAt =
      summary.lastSyncedAt ??
      (operationState?.finishedAt as string) ??
      (sync?.syncedAt as string) ??
      null;
    return {
      ...summary,
      lastSyncedAt,
      revision,
      branchName: source?.targetRevision ?? null,
      conditions,
    };
  }

  async updateSyncPolicy(appName: string, syncPolicy: 'automated' | 'none'): Promise<void> {
    const app = await this.getApplicationRaw(appName);
    const spec = (app.spec as Record<string, unknown>) ?? {};
    if (syncPolicy === 'automated') {
      const existing = (spec.syncPolicy as Record<string, unknown>) ?? {};
      spec.syncPolicy = { ...existing, automated: { prune: true, selfHeal: true } };
    } else {
      // Remove the automated block so Argo stops auto-syncing/self-healing.
      const existing = (spec.syncPolicy as Record<string, unknown>) ?? {};
      const { automated: _automated, ...rest } = existing;
      spec.syncPolicy = rest;
    }
    // Use PUT (the Update endpoint) with the full application body. The PATCH
    // endpoint expects an ApplicationPatchRequest ({patch, patchType}); sending a
    // full app there silently no-ops, leaving automated sync enabled.
    const res = await argoFetch(`${this.baseUrl}/applications/${encodeURIComponent(appName)}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ ...app, spec }),
      insecureTls: this.instance.insecureTls,
      timeoutMs: 30_000,
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

  async getApplicationRaw(appName: string): Promise<Record<string, unknown>> {
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

  async getApplicationProjectName(appName: string): Promise<string> {
    const app = await this.getApplicationRaw(appName);
    const spec = app.spec as Record<string, unknown> | undefined;
    const project = spec?.project;
    return typeof project === 'string' && project.trim() ? project : 'default';
  }

  async getProjectRaw(projectName: string): Promise<Record<string, unknown>> {
    const res = await argoFetch(`${this.baseUrl}/projects/${encodeURIComponent(projectName)}`, {
      headers: this.headers,
      insecureTls: this.instance.insecureTls,
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get ArgoCD project ${projectName}: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (data.project && typeof data.project === 'object') {
      return data.project as Record<string, unknown>;
    }
    return data;
  }

  async updateProjectRaw(projectName: string, project: Record<string, unknown>): Promise<void> {
    const res = await argoFetch(`${this.baseUrl}/projects/${encodeURIComponent(projectName)}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ project }),
      insecureTls: this.instance.insecureTls,
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      const text = await res.text();
      const hint =
        res.status === 403
          ? ' — Argo CD token needs permission to update AppProjects (projects, update).'
          : '';
      throw new Error(
        `Failed to update ArgoCD project ${projectName}: ${res.status} ${text}${hint}`
      );
    }
  }

  private async mutateProjectSpec(
    projectName: string,
    mutate: (project: Record<string, unknown>) => void
  ): Promise<void> {
    return this.runProjectLocked(projectName, async () => {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const project = await this.getProjectRaw(projectName);
        mutate(project);
        try {
          await this.updateProjectRaw(projectName, project);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
      }
      throw lastError ?? new Error(`Failed to update ArgoCD project ${projectName}`);
    });
  }

  private readProjectSyncWindows(project: Record<string, unknown>): ArgoSyncWindowSpec[] {
    const spec = (project.spec as Record<string, unknown>) ?? {};
    const rows = spec.syncWindows;
    return Array.isArray(rows) ? (rows as ArgoSyncWindowSpec[]) : [];
  }

  async addScheduleManualSyncDenyWindow(input: {
    appName: string;
    blockFrom: Date;
    blockUntil: Date;
    timeZone: string;
  }): Promise<void> {
    return this.addScheduleManualSyncDenyWindows({
      appNames: [input.appName],
      blockUntil: input.blockUntil,
      timeZone: input.timeZone,
    });
  }

  /** One project PUT for many apps — avoids 409 duplicate schedule rows on EC2. */
  async addScheduleManualSyncDenyWindows(input: {
    appNames: string[];
    blockUntil: Date;
    timeZone: string;
  }): Promise<void> {
    const appNames = Array.from(new Set(input.appNames.filter(Boolean)));
    if (!appNames.length) return;

    const byProject = new Map<string, string[]>();
    for (const appName of appNames) {
      const projectName = await this.getApplicationProjectName(appName);
      const bucket = byProject.get(projectName) ?? [];
      bucket.push(appName);
      byProject.set(projectName, bucket);
    }

    for (const [projectName, projectApps] of Array.from(byProject.entries())) {
      const windowStart = new Date();
      const nextWindow = buildScheduleDenySyncWindow({
        appNames: projectApps,
        blockUntil: input.blockUntil,
        timeZone: input.timeZone,
        windowStart,
      });

      const applyMerge = (project: Record<string, unknown>) => {
        const spec = (project.spec as Record<string, unknown>) ?? {};
        spec.syncWindows = mergeScheduleDenySyncWindow(
          this.readProjectSyncWindows(project),
          nextWindow
        );
        project.spec = spec;
      };

      try {
        await this.mutateProjectSpec(projectName, applyMerge);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('already exists')) throw err;
        await this.mutateProjectSpec(projectName, applyMerge);
      }

      console.log(
        `[Argo sync window] deny window set in project ${projectName} for ${projectApps.length} app(s): ` +
          `schedule=${nextWindow.schedule} duration=${nextWindow.duration} tz=${nextWindow.timeZone}`
      );
    }
  }

  async addScheduleNamespaceDenyWindow(input: {
    namespace: string;
    blockUntil: Date;
    timeZone: string;
    sampleAppName: string;
  }): Promise<void> {
    const projectName = await this.getApplicationProjectName(input.sampleAppName);
    const windowStart = new Date();
    const nextWindow = buildNamespaceDenySyncWindow({
      namespace: input.namespace,
      blockUntil: input.blockUntil,
      timeZone: input.timeZone,
      windowStart,
    });

    const applyMerge = (project: Record<string, unknown>) => {
      const spec = (project.spec as Record<string, unknown>) ?? {};
      spec.syncWindows = mergeNamespaceDenySyncWindow(
        this.readProjectSyncWindows(project),
        nextWindow
      );
      project.spec = spec;
    };

    try {
      await this.mutateProjectSpec(projectName, applyMerge);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('already exists')) throw err;
      await this.mutateProjectSpec(projectName, applyMerge);
    }

    console.log(
      `[Argo sync window] namespace deny set in project ${projectName} for ${input.namespace}: ` +
        `schedule=${nextWindow.schedule} duration=${nextWindow.duration} tz=${nextWindow.timeZone}`
    );
  }

  async removeScheduleNamespaceDenyWindow(namespace: string, sampleAppName: string): Promise<number> {
    const projectName = await this.getApplicationProjectName(sampleAppName);
    let removed = 0;

    await this.mutateProjectSpec(projectName, (project) => {
      const result = removeScheduleNamespaceDenyWindow(
        this.readProjectSyncWindows(project),
        namespace
      );
      removed = result.removed;
      const spec = (project.spec as Record<string, unknown>) ?? {};
      spec.syncWindows = result.windows;
      project.spec = spec;
    });

    return removed;
  }

  async removeScheduleManualSyncDenyWindows(appName: string): Promise<number> {
    const projectName = await this.getApplicationProjectName(appName);
    let removed = 0;

    await this.mutateProjectSpec(projectName, (project) => {
      const existing = this.readProjectSyncWindows(project);
      const result = removeScheduleDenySyncWindows(existing, appName);
      removed = result.removed;
      const spec = (project.spec as Record<string, unknown>) ?? {};
      spec.syncWindows = result.windows;
      project.spec = spec;
    });

    return removed;
  }

  async getManagedResources(appName: string): Promise<ArgoCDManagedResourceItem[]> {
    const res = await argoFetch(
      `${this.baseUrl}/applications/${encodeURIComponent(appName)}/managed-resources`,
      {
        headers: this.headers,
        insecureTls: this.instance.insecureTls,
        timeoutMs: 30_000,
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to list managed resources for ${appName}: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { items?: Record<string, unknown>[] };
    return (data.items ?? []).map((item) => ({
      group: String(item.group ?? ''),
      kind: String(item.kind ?? ''),
      namespace: String(item.namespace ?? ''),
      name: String(item.name ?? ''),
      liveState: String(item.liveState ?? ''),
      targetState: item.targetState ? String(item.targetState) : undefined,
    }));
  }

  async getRevisionMetadata(
    appName: string,
    revisionSha: string
  ): Promise<ArgoCDRevisionMetadata | null> {
    if (!revisionSha) return null;
    const res = await argoFetch(
      `${this.baseUrl}/applications/${encodeURIComponent(appName)}/revisions/${encodeURIComponent(revisionSha)}/metadata`,
      {
        headers: this.headers,
        insecureTls: this.instance.insecureTls,
        timeoutMs: 20_000,
      }
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get revision metadata: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      author: String(data.author ?? 'Unknown'),
      date: String(data.date ?? ''),
      message: String(data.message ?? ''),
      tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    };
  }

  async getApplicationHistory(appName: string): Promise<ArgoCDHistoryEntry[]> {
    const raw = await this.getApplicationRaw(appName);
    const metadata = raw.metadata as Record<string, string> | undefined;
    const status = raw.status as Record<string, unknown> | undefined;
    const history =
      (status?.history as {
        revision?: string;
        deployedAt?: string;
        source?: { targetRevision?: string };
      }[]) ?? [];
    const appNamespace = metadata?.namespace ?? 'argocd';

    return history
      .filter((h) => h.revision && h.deployedAt)
      .map((h) => ({
        revision: h.revision as string,
        deployedAt: new Date(h.deployedAt as string),
        appNamespace,
        branchName: h.source?.targetRevision ?? null,
      }))
      .filter((h) => !Number.isNaN(h.deployedAt.getTime()));
  }

  async getManifestsAtRevision(
    appName: string,
    revision: string,
    appNamespace: string
  ): Promise<string[]> {
    const params = new URLSearchParams({
      revision,
      appNamespace,
    });
    const res = await argoFetch(
      `${this.baseUrl}/applications/${encodeURIComponent(appName)}/manifests?${params.toString()}`,
      {
        headers: this.headers,
        insecureTls: this.instance.insecureTls,
        timeoutMs: 45_000,
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get manifests for ${appName}@${revision}: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { manifests?: string[] };
    return data.manifests ?? [];
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

export { InstanceArgoCDClient };

function clientFor(instance: ArgoCDInstanceConfig) {
  return new InstanceArgoCDClient(instance);
}

export async function getEnabledArgoCDClients(): Promise<
  { instance: ArgoCDInstanceConfig; client: InstanceArgoCDClient }[]
> {
  const instances = await resolveInstances();
  return instances.map((instance) => ({ instance, client: clientFor(instance) }));
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
    if (appsListCache && Date.now() - appsListCache.at < APPS_LIST_CACHE_TTL_MS) {
      return appsListCache.apps;
    }

    const instances = await resolveInstances();
    if (!instances.length) {
      throw new Error('No ArgoCD instances configured. Add them in Admin → Settings.');
    }

    const settled = await Promise.allSettled(
      instances.map(async (instance) => {
        const listed = await clientFor(instance).listApplications();
        return listed;
      })
    );

    const apps: ArgoCDAppSummary[] = [];
    const errors: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        apps.push(...result.value);
      } else {
        errors.push(
          `${instances[i].name}: ${result.reason instanceof Error ? result.reason.message : 'unreachable'}`
        );
      }
    }

    if (!apps.length) {
      throw new Error(errors.join('; ') || 'All ArgoCD instances unreachable');
    }

    appsListCache = { at: Date.now(), apps };
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

  async addScheduleManualSyncDenyWindow(
    input: {
      appName: string;
      blockFrom: Date;
      blockUntil: Date;
      timeZone: string;
    },
    instanceId?: string
  ): Promise<void> {
    const { client } = await resolveInstanceForApp(input.appName, instanceId);
    return client.addScheduleManualSyncDenyWindow(input);
  }

  async addScheduleManualSyncDenyWindows(
    input: {
      appNames: string[];
      blockUntil: Date;
      timeZone: string;
    },
    instanceId?: string
  ): Promise<void> {
    if (!input.appNames.length) return;
    const { client } = await resolveInstanceForApp(input.appNames[0], instanceId);
    return client.addScheduleManualSyncDenyWindows(input);
  }

  async addScheduleNamespaceDenyWindow(
    input: {
      namespace: string;
      blockUntil: Date;
      timeZone: string;
      sampleAppName: string;
    },
    instanceId?: string
  ): Promise<void> {
    const { client } = await resolveInstanceForApp(input.sampleAppName, instanceId);
    return client.addScheduleNamespaceDenyWindow(input);
  }

  async removeScheduleNamespaceDenyWindow(
    namespace: string,
    sampleAppName: string,
    instanceId?: string
  ): Promise<number> {
    const { client } = await resolveInstanceForApp(sampleAppName, instanceId);
    return client.removeScheduleNamespaceDenyWindow(namespace, sampleAppName);
  }

  async removeScheduleManualSyncDenyWindows(
    appName: string,
    instanceId?: string
  ): Promise<number> {
    const { client } = await resolveInstanceForApp(appName, instanceId);
    return client.removeScheduleManualSyncDenyWindows(appName);
  }

  async getManagedResources(
    appName: string,
    instanceId?: string
  ): Promise<ArgoCDManagedResourceItem[]> {
    const { client } = await resolveInstanceForApp(appName, instanceId);
    return client.getManagedResources(appName);
  }

  async getRevisionMetadata(
    appName: string,
    revisionSha: string,
    instanceId?: string
  ): Promise<ArgoCDRevisionMetadata | null> {
    const { client } = await resolveInstanceForApp(appName, instanceId);
    return client.getRevisionMetadata(appName, revisionSha);
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
