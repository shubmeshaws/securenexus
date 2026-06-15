import prisma from './prisma';
import {
  DEFAULT_RESOURCE_AUDIT_DATA_START,
  DEFAULT_RESOURCE_AUDIT_RETENTION_AMOUNT,
  DEFAULT_RESOURCE_AUDIT_RETENTION_UNIT,
  RESOURCE_AUDIT_RETENTION_UNITS,
  type ResourceAuditRetentionUnit,
} from '@/lib/resource-audit-retention';
import { decryptSecret, encryptSecret } from '@/lib/crypto';

export const SETTING_KEYS = {
  ARGOCD_SERVER: 'argocd_server',
  ARGOCD_TOKEN: 'argocd_token',
  KUBECONFIG_BASE64: 'kubeconfig_base64',
  GOOGLE_ALLOWED_DOMAIN: 'google_allowed_domain',
  DEMO_MODE: 'demo_mode',
  REDIS_URL: 'redis_url',
  API_BASE_URL: 'api_base_url',
  ARGOCD_INSECURE_TLS: 'argocd_insecure_tls',
  SETUP_COMPLETE: 'setup_complete',
  ACTIVITY_LOG_RETENTION_DAYS: 'activity_log_retention_days',
  RESOURCE_AUDIT_RETENTION_AMOUNT: 'resource_audit_retention_amount',
  RESOURCE_AUDIT_RETENTION_UNIT: 'resource_audit_retention_unit',
  RESOURCE_AUDIT_DATA_START_DATE: 'resource_audit_data_start_date',
  AWS_ACCESS_KEY_ID: 'aws_access_key_id',
  AWS_SECRET_ACCESS_KEY: 'aws_secret_access_key',
  AWS_DEFAULT_REGION: 'aws_default_region',
  AWS_LAST_TEST_AT: 'aws_last_test_at',
  AWS_LAST_TEST_OK: 'aws_last_test_ok',
  AWS_LAST_TEST_MESSAGE: 'aws_last_test_message',
  AWS_IAM_USERNAME: 'aws_iam_username',
} as const;

type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

const SECRET_KEYS = new Set<SettingKey>([
  SETTING_KEYS.ARGOCD_TOKEN,
  SETTING_KEYS.KUBECONFIG_BASE64,
  SETTING_KEYS.AWS_SECRET_ACCESS_KEY,
]);

const ENV_FALLBACK: Record<SettingKey, () => string | undefined> = {
  [SETTING_KEYS.ARGOCD_SERVER]: () => process.env.ARGOCD_SERVER,
  [SETTING_KEYS.ARGOCD_TOKEN]: () => process.env.ARGOCD_TOKEN,
  [SETTING_KEYS.KUBECONFIG_BASE64]: () => process.env.KUBECONFIG_BASE64,
  [SETTING_KEYS.GOOGLE_ALLOWED_DOMAIN]: () => process.env.GOOGLE_ALLOWED_DOMAIN,
  [SETTING_KEYS.DEMO_MODE]: () => {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') return 'true';
    return 'false';
  },
  [SETTING_KEYS.REDIS_URL]: () => process.env.REDIS_URL,
  [SETTING_KEYS.API_BASE_URL]: () => process.env.NEXT_PUBLIC_API_URL,
  [SETTING_KEYS.ARGOCD_INSECURE_TLS]: () =>
    process.env.ARGOCD_INSECURE_TLS === 'true' ? 'true' : undefined,
  [SETTING_KEYS.SETUP_COMPLETE]: () => undefined,
  [SETTING_KEYS.ACTIVITY_LOG_RETENTION_DAYS]: () => '90',
  [SETTING_KEYS.RESOURCE_AUDIT_RETENTION_AMOUNT]: () => '3',
  [SETTING_KEYS.RESOURCE_AUDIT_RETENTION_UNIT]: () => 'months',
  [SETTING_KEYS.RESOURCE_AUDIT_DATA_START_DATE]: () => '2026-06-01',
  [SETTING_KEYS.AWS_ACCESS_KEY_ID]: () => process.env.AWS_ACCESS_KEY_ID,
  [SETTING_KEYS.AWS_SECRET_ACCESS_KEY]: () => process.env.AWS_SECRET_ACCESS_KEY,
  [SETTING_KEYS.AWS_DEFAULT_REGION]: () => process.env.AWS_DEFAULT_REGION ?? 'ap-south-1',
  [SETTING_KEYS.AWS_LAST_TEST_AT]: () => undefined,
  [SETTING_KEYS.AWS_LAST_TEST_OK]: () => undefined,
  [SETTING_KEYS.AWS_LAST_TEST_MESSAGE]: () => undefined,
  [SETTING_KEYS.AWS_IAM_USERNAME]: () => undefined,
};

export function normalizeArgoCDServer(url: string): string {
  let trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

let cache: Map<string, string> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15_000;

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

export function invalidateSettingsCache() {
  invalidateCache();
}

async function loadAllSettings(): Promise<Map<string, string>> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const rows = await prisma.systemSetting.findMany();
  cache = new Map(rows.map((r) => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}

export async function getSetting(key: SettingKey): Promise<string | null> {
  const all = await loadAllSettings();
  const stored = all.get(key);
  if (stored !== undefined) {
    if (!stored) return null;
    if (SECRET_KEYS.has(key)) {
      try {
        return decryptSecret(stored);
      } catch {
        return null;
      }
    }
    return stored;
  }
  return ENV_FALLBACK[key]() ?? null;
}

export async function isDemoModeServer(): Promise<boolean> {
  const value = await getSetting(SETTING_KEYS.DEMO_MODE);
  return value === 'true';
}

export async function getArgoCDConfig(): Promise<{
  server: string;
  token: string;
  insecureTls: boolean;
}> {
  const server = normalizeArgoCDServer((await getSetting(SETTING_KEYS.ARGOCD_SERVER)) ?? '');
  const token = (await getSetting(SETTING_KEYS.ARGOCD_TOKEN)) ?? '';
  const insecureTls = (await getSetting(SETTING_KEYS.ARGOCD_INSECURE_TLS)) === 'true';
  return { server, token, insecureTls };
}

export async function getKubeconfigBase64(): Promise<string | null> {
  return getSetting(SETTING_KEYS.KUBECONFIG_BASE64);
}

export async function getAllowedDomain(): Promise<string | null> {
  const domain = await getSetting(SETTING_KEYS.GOOGLE_ALLOWED_DOMAIN);
  return domain?.trim() || null;
}

export interface AdminSettingsView {
  argocdServer: string;
  argocdTokenSet: boolean;
  argocdInsecureTls: boolean;
  kubeconfigSet: boolean;
  googleAllowedDomain: string;
  demoMode: boolean;
  redisUrl: string;
  apiBaseUrl: string;
  activityLogRetentionDays: number;
  resourceAuditRetentionAmount: number;
  resourceAuditRetentionUnit: 'weeks' | 'months' | 'years';
  resourceAuditDataStartDate: string;
}

export async function getAdminSettings(): Promise<AdminSettingsView> {
  const all = await loadAllSettings();
  const read = (key: SettingKey) => {
    const stored = all.get(key);
    if (stored !== undefined) return stored;
    return ENV_FALLBACK[key]() ?? '';
  };

  return {
    argocdServer: read(SETTING_KEYS.ARGOCD_SERVER),
    argocdTokenSet: Boolean(read(SETTING_KEYS.ARGOCD_TOKEN)),
    argocdInsecureTls: read(SETTING_KEYS.ARGOCD_INSECURE_TLS) === 'true',
    kubeconfigSet: Boolean(read(SETTING_KEYS.KUBECONFIG_BASE64)),
    googleAllowedDomain: read(SETTING_KEYS.GOOGLE_ALLOWED_DOMAIN),
    demoMode: read(SETTING_KEYS.DEMO_MODE) === 'true',
    redisUrl: read(SETTING_KEYS.REDIS_URL),
    apiBaseUrl: read(SETTING_KEYS.API_BASE_URL),
    activityLogRetentionDays: Math.max(
      1,
      parseInt(read(SETTING_KEYS.ACTIVITY_LOG_RETENTION_DAYS) || '90', 10) || 90
    ),
    resourceAuditRetentionAmount: Math.max(
      1,
      parseInt(read(SETTING_KEYS.RESOURCE_AUDIT_RETENTION_AMOUNT) || String(DEFAULT_RESOURCE_AUDIT_RETENTION_AMOUNT), 10) ||
        DEFAULT_RESOURCE_AUDIT_RETENTION_AMOUNT
    ),
    resourceAuditRetentionUnit: (() => {
      const unit = read(SETTING_KEYS.RESOURCE_AUDIT_RETENTION_UNIT).trim().toLowerCase();
      return (RESOURCE_AUDIT_RETENTION_UNITS as readonly string[]).includes(unit)
        ? (unit as ResourceAuditRetentionUnit)
        : DEFAULT_RESOURCE_AUDIT_RETENTION_UNIT;
    })(),
    resourceAuditDataStartDate: (() => {
      const value = read(SETTING_KEYS.RESOURCE_AUDIT_DATA_START_DATE).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : DEFAULT_RESOURCE_AUDIT_DATA_START;
    })(),
  };
}

export interface AdminSettingsInput {
  argocdServer?: string;
  argocdToken?: string;
  argocdInsecureTls?: boolean;
  kubeconfigBase64?: string;
  googleAllowedDomain?: string;
  demoMode?: boolean;
  redisUrl?: string;
  apiBaseUrl?: string;
  activityLogRetentionDays?: number;
  resourceAuditRetentionAmount?: number;
  resourceAuditRetentionUnit?: ResourceAuditRetentionUnit;
  resourceAuditDataStartDate?: string;
}

const SECRET_PLACEHOLDER = '••••••••';

export async function updateAdminSettings(
  input: AdminSettingsInput,
  updatedBy?: string
): Promise<AdminSettingsView> {
  const upserts: { key: string; value: string; isSecret: boolean }[] = [];

  if (input.argocdServer !== undefined) {
    upserts.push({
      key: SETTING_KEYS.ARGOCD_SERVER,
      value: normalizeArgoCDServer(input.argocdServer),
      isSecret: false,
    });
  }
  if (input.argocdInsecureTls !== undefined) {
    upserts.push({
      key: SETTING_KEYS.ARGOCD_INSECURE_TLS,
      value: input.argocdInsecureTls ? 'true' : 'false',
      isSecret: false,
    });
  }
  if (input.argocdToken !== undefined && input.argocdToken !== SECRET_PLACEHOLDER) {
    upserts.push({
      key: SETTING_KEYS.ARGOCD_TOKEN,
      value: input.argocdToken ? encryptSecret(input.argocdToken) : '',
      isSecret: true,
    });
  }
  if (input.kubeconfigBase64 !== undefined && input.kubeconfigBase64 !== SECRET_PLACEHOLDER) {
    upserts.push({
      key: SETTING_KEYS.KUBECONFIG_BASE64,
      value: input.kubeconfigBase64 ? encryptSecret(input.kubeconfigBase64) : '',
      isSecret: true,
    });
  }
  if (input.googleAllowedDomain !== undefined) {
    upserts.push({
      key: SETTING_KEYS.GOOGLE_ALLOWED_DOMAIN,
      value: input.googleAllowedDomain.trim(),
      isSecret: false,
    });
  }
  if (input.demoMode !== undefined) {
    upserts.push({
      key: SETTING_KEYS.DEMO_MODE,
      value: input.demoMode ? 'true' : 'false',
      isSecret: false,
    });
  }
  if (input.redisUrl !== undefined) {
    upserts.push({
      key: SETTING_KEYS.REDIS_URL,
      value: input.redisUrl.trim(),
      isSecret: false,
    });
  }
  if (input.apiBaseUrl !== undefined) {
    upserts.push({
      key: SETTING_KEYS.API_BASE_URL,
      value: input.apiBaseUrl.trim(),
      isSecret: false,
    });
  }
  if (input.activityLogRetentionDays !== undefined) {
    const days = Math.min(3650, Math.max(1, Math.round(input.activityLogRetentionDays)));
    upserts.push({
      key: SETTING_KEYS.ACTIVITY_LOG_RETENTION_DAYS,
      value: String(days),
      isSecret: false,
    });
  }
  if (
    input.resourceAuditRetentionAmount !== undefined ||
    input.resourceAuditRetentionUnit !== undefined
  ) {
    const current = await getAdminSettings();
    const unit = input.resourceAuditRetentionUnit ?? current.resourceAuditRetentionUnit;
    if (!(RESOURCE_AUDIT_RETENTION_UNITS as readonly string[]).includes(unit)) {
      throw new Error('Invalid resource audit retention unit');
    }
    const amountRaw = input.resourceAuditRetentionAmount ?? current.resourceAuditRetentionAmount;
    const max = unit === 'weeks' ? 52 : unit === 'months' ? 36 : 10;
    const amount = Math.min(max, Math.max(1, Math.round(amountRaw)));
    upserts.push(
      {
        key: SETTING_KEYS.RESOURCE_AUDIT_RETENTION_AMOUNT,
        value: String(amount),
        isSecret: false,
      },
      {
        key: SETTING_KEYS.RESOURCE_AUDIT_RETENTION_UNIT,
        value: unit,
        isSecret: false,
      }
    );
  }
  if (input.resourceAuditDataStartDate !== undefined) {
    const value = input.resourceAuditDataStartDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('Invalid resource audit data start date');
    }
    upserts.push({
      key: SETTING_KEYS.RESOURCE_AUDIT_DATA_START_DATE,
      value,
      isSecret: false,
    });
  }

  for (const row of upserts) {
    await prisma.systemSetting.upsert({
      where: { key: row.key },
      create: { key: row.key, value: row.value, isSecret: row.isSecret, updatedBy },
      update: { value: row.value, isSecret: row.isSecret, updatedBy },
    });
  }

  invalidateCache();
  return getAdminSettings();
}

export { SECRET_PLACEHOLDER };
