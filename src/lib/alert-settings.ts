import prisma from '@/lib/prisma';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { ActivityAction } from '@/lib/activity';

export const ALERT_SETTING_KEYS = {
  CONFIG: 'alerts_config',
  TEAMS_WEBHOOK: 'alerts_teams_webhook',
  SMTP_PASSWORD: 'alerts_smtp_password',
} as const;

export const DEFAULT_ALERT_EVENTS: ActivityAction[] = [
  'schedule-shutdown',
  'schedule-startup',
  'schedule-run',
  'scale-down',
  'scale-up',
  'infra-shutdown',
  'infra-startup',
];

export interface AlertConfigJson {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  teamsEnabled: boolean;
  emailRecipients: string[];
  emailFrom: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpSecure: boolean;
  events: ActivityAction[];
}

export const DEFAULT_ALERT_CONFIG: AlertConfigJson = {
  inAppEnabled: true,
  emailEnabled: false,
  teamsEnabled: false,
  emailRecipients: [],
  emailFrom: '',
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpSecure: false,
  events: [...DEFAULT_ALERT_EVENTS],
};

export interface AlertSettingsView {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  teamsEnabled: boolean;
  emailRecipients: string[];
  emailFrom: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpSecure: boolean;
  teamsWebhookSet: boolean;
  smtpPasswordSet: boolean;
  events: ActivityAction[];
}

export interface AlertSettingsInput {
  inAppEnabled?: boolean;
  emailEnabled?: boolean;
  teamsEnabled?: boolean;
  emailRecipients?: string[];
  emailFrom?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpSecure?: boolean;
  teamsWebhookUrl?: string;
  smtpPassword?: string;
  events?: ActivityAction[];
}

export const SECRET_PLACEHOLDER = '••••••••';

let cache: Map<string, string> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15_000;

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

async function loadAll(): Promise<Map<string, string>> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const rows = await prisma.systemSetting.findMany({
    where: {
      key: { in: Object.values(ALERT_SETTING_KEYS) },
    },
  });
  cache = new Map(rows.map((r) => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}

function parseConfig(raw: string | undefined): AlertConfigJson {
  if (!raw) return { ...DEFAULT_ALERT_CONFIG, events: [...DEFAULT_ALERT_EVENTS] };
  try {
    const parsed = JSON.parse(raw) as Partial<AlertConfigJson>;
    return {
      ...DEFAULT_ALERT_CONFIG,
      ...parsed,
      events: parsed.events?.length ? parsed.events : [...DEFAULT_ALERT_EVENTS],
      emailRecipients: parsed.emailRecipients ?? [],
    };
  } catch {
    return { ...DEFAULT_ALERT_CONFIG, events: [...DEFAULT_ALERT_EVENTS] };
  }
}

export async function getAlertSettings(): Promise<AlertSettingsView> {
  const all = await loadAll();
  const config = parseConfig(all.get(ALERT_SETTING_KEYS.CONFIG));
  const webhook = all.get(ALERT_SETTING_KEYS.TEAMS_WEBHOOK);
  const smtpPass = all.get(ALERT_SETTING_KEYS.SMTP_PASSWORD);

  return {
    inAppEnabled: config.inAppEnabled,
    emailEnabled: config.emailEnabled,
    teamsEnabled: config.teamsEnabled,
    emailRecipients: config.emailRecipients,
    emailFrom: config.emailFrom,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpUser: config.smtpUser,
    smtpSecure: config.smtpSecure,
    teamsWebhookSet: Boolean(webhook),
    smtpPasswordSet: Boolean(smtpPass),
    events: config.events,
  };
}

export async function getTeamsWebhookUrl(): Promise<string | null> {
  const all = await loadAll();
  const stored = all.get(ALERT_SETTING_KEYS.TEAMS_WEBHOOK);
  if (!stored) return process.env.ALERTS_TEAMS_WEBHOOK_URL ?? null;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

export async function getSmtpPassword(): Promise<string | null> {
  const all = await loadAll();
  const stored = all.get(ALERT_SETTING_KEYS.SMTP_PASSWORD);
  if (!stored) return process.env.ALERTS_SMTP_PASSWORD ?? null;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

export async function getAlertConfigFull(): Promise<AlertConfigJson> {
  const all = await loadAll();
  return parseConfig(all.get(ALERT_SETTING_KEYS.CONFIG));
}

export async function updateAlertSettings(
  input: AlertSettingsInput,
  updatedBy?: string
): Promise<AlertSettingsView> {
  const current = parseConfig((await loadAll()).get(ALERT_SETTING_KEYS.CONFIG));

  const next: AlertConfigJson = {
    inAppEnabled: input.inAppEnabled ?? current.inAppEnabled,
    emailEnabled: input.emailEnabled ?? current.emailEnabled,
    teamsEnabled: input.teamsEnabled ?? current.teamsEnabled,
    emailRecipients: input.emailRecipients ?? current.emailRecipients,
    emailFrom: input.emailFrom ?? current.emailFrom,
    smtpHost: input.smtpHost ?? current.smtpHost,
    smtpPort: input.smtpPort ?? current.smtpPort,
    smtpUser: input.smtpUser ?? current.smtpUser,
    smtpSecure: input.smtpSecure ?? current.smtpSecure,
    events: input.events ?? current.events,
  };

  await prisma.systemSetting.upsert({
    where: { key: ALERT_SETTING_KEYS.CONFIG },
    create: {
      key: ALERT_SETTING_KEYS.CONFIG,
      value: JSON.stringify(next),
      isSecret: false,
      updatedBy,
    },
    update: { value: JSON.stringify(next), updatedBy },
  });

  if (
    input.teamsWebhookUrl !== undefined &&
    input.teamsWebhookUrl !== SECRET_PLACEHOLDER
  ) {
    await prisma.systemSetting.upsert({
      where: { key: ALERT_SETTING_KEYS.TEAMS_WEBHOOK },
      create: {
        key: ALERT_SETTING_KEYS.TEAMS_WEBHOOK,
        value: input.teamsWebhookUrl ? encryptSecret(input.teamsWebhookUrl.trim()) : '',
        isSecret: true,
        updatedBy,
      },
      update: {
        value: input.teamsWebhookUrl ? encryptSecret(input.teamsWebhookUrl.trim()) : '',
        updatedBy,
      },
    });
  }

  if (input.smtpPassword !== undefined && input.smtpPassword !== SECRET_PLACEHOLDER) {
    await prisma.systemSetting.upsert({
      where: { key: ALERT_SETTING_KEYS.SMTP_PASSWORD },
      create: {
        key: ALERT_SETTING_KEYS.SMTP_PASSWORD,
        value: input.smtpPassword ? encryptSecret(input.smtpPassword) : '',
        isSecret: true,
        updatedBy,
      },
      update: {
        value: input.smtpPassword ? encryptSecret(input.smtpPassword) : '',
        updatedBy,
      },
    });
  }

  invalidateCache();
  return getAlertSettings();
}

export function shouldAlertForEvent(
  config: AlertConfigJson,
  action: ActivityAction
): boolean {
  if (action === 'alert-broadcast') return config.inAppEnabled;
  return config.events.includes(action);
}
