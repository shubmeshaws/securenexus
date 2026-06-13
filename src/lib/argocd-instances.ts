import prisma from './prisma';
import { decryptSecret, encryptSecret } from './crypto';
import { getSetting, normalizeArgoCDServer, SETTING_KEYS } from './settings';

const SECRET_PLACEHOLDER = '••••••••';

export interface ArgoCDInstanceView {
  id: string;
  name: string;
  serverUrl: string;
  tokenSet: boolean;
  insecureTls: boolean;
  enabled: boolean;
  clusterNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ArgoCDInstanceConfig {
  id: string;
  name: string;
  serverUrl: string;
  token: string;
  insecureTls: boolean;
  enabled: boolean;
  clusterNames: string[];
}

function toView(row: {
  id: string;
  name: string;
  serverUrl: string;
  tokenEnc: string;
  insecureTls: boolean;
  enabled: boolean;
  clusterNames: string[];
  createdAt: Date;
  updatedAt: Date;
}): ArgoCDInstanceView {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.serverUrl,
    tokenSet: Boolean(row.tokenEnc),
    insecureTls: row.insecureTls,
    enabled: row.enabled,
    clusterNames: row.clusterNames ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function decryptToken(tokenEnc: string): string {
  if (!tokenEnc) return '';
  try {
    return decryptSecret(tokenEnc);
  } catch {
    return '';
  }
}

export async function migrateLegacyArgoCDSettings(): Promise<void> {
  const count = await prisma.argoCDInstance.count();
  if (count > 0) return;

  const server = normalizeArgoCDServer((await getSetting(SETTING_KEYS.ARGOCD_SERVER)) ?? '');
  const token = (await getSetting(SETTING_KEYS.ARGOCD_TOKEN)) ?? '';
  const insecureTls = (await getSetting(SETTING_KEYS.ARGOCD_INSECURE_TLS)) === 'true';

  if (!server && !token) return;

  await prisma.argoCDInstance.create({
    data: {
      name: 'Default',
      serverUrl: server,
      tokenEnc: token ? encryptSecret(token) : '',
      insecureTls,
      enabled: true,
      clusterNames: [],
    },
  });
}

export async function listArgoCDInstanceViews(): Promise<ArgoCDInstanceView[]> {
  await migrateLegacyArgoCDSettings();
  const rows = await prisma.argoCDInstance.findMany({ orderBy: { name: 'asc' } });
  return rows.map(toView);
}

export async function listEnabledArgoCDInstances(): Promise<ArgoCDInstanceConfig[]> {
  await migrateLegacyArgoCDSettings();
  const rows = await prisma.argoCDInstance.findMany({
    where: { enabled: true },
    orderBy: { name: 'asc' },
  });

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      serverUrl: normalizeArgoCDServer(row.serverUrl),
      token: decryptToken(row.tokenEnc),
      insecureTls: row.insecureTls,
      enabled: row.enabled,
      clusterNames: row.clusterNames ?? [],
    }))
    .filter((row) => row.serverUrl && row.token);
}

export async function getArgoCDInstanceConfig(id: string): Promise<ArgoCDInstanceConfig | null> {
  const row = await prisma.argoCDInstance.findUnique({ where: { id } });
  if (!row) return null;
  const token = decryptToken(row.tokenEnc);
  const serverUrl = normalizeArgoCDServer(row.serverUrl);
  if (!serverUrl || !token) return null;
  return {
    id: row.id,
    name: row.name,
    serverUrl,
    token,
    insecureTls: row.insecureTls,
    enabled: row.enabled,
    clusterNames: row.clusterNames ?? [],
  };
}

export async function createArgoCDInstance(input: {
  name: string;
  serverUrl: string;
  token?: string;
  insecureTls?: boolean;
  enabled?: boolean;
  clusterNames?: string[];
}): Promise<ArgoCDInstanceView> {
  const row = await prisma.argoCDInstance.create({
    data: {
      name: input.name.trim(),
      serverUrl: normalizeArgoCDServer(input.serverUrl),
      tokenEnc: input.token?.trim() ? encryptSecret(input.token.trim()) : '',
      insecureTls: input.insecureTls ?? false,
      enabled: input.enabled ?? true,
      clusterNames: input.clusterNames ?? [],
    },
  });
  return toView(row);
}

export async function updateArgoCDInstance(
  id: string,
  input: {
    name?: string;
    serverUrl?: string;
    token?: string;
    insecureTls?: boolean;
    enabled?: boolean;
    clusterNames?: string[];
  }
): Promise<ArgoCDInstanceView> {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.serverUrl !== undefined) data.serverUrl = normalizeArgoCDServer(input.serverUrl);
  if (input.insecureTls !== undefined) data.insecureTls = input.insecureTls;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.clusterNames !== undefined) data.clusterNames = input.clusterNames;
  if (input.token !== undefined && input.token !== SECRET_PLACEHOLDER) {
    data.tokenEnc = input.token.trim() ? encryptSecret(input.token.trim()) : '';
  }

  const row = await prisma.argoCDInstance.update({ where: { id }, data });
  return toView(row);
}

export async function deleteArgoCDInstance(id: string): Promise<void> {
  await prisma.argoCDInstance.delete({ where: { id } });
}

export function instanceMatchesCluster(instance: ArgoCDInstanceConfig, cluster: string): boolean {
  if (!instance.clusterNames.length) return true;
  const normalized = cluster.toLowerCase();
  return instance.clusterNames.some((name) => {
    const n = name.toLowerCase().trim();
    return n === normalized || normalized.includes(n) || n.includes(normalized);
  });
}

export { SECRET_PLACEHOLDER };
