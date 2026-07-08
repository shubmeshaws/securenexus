import fs from 'fs/promises';
import path from 'path';

export interface SonarqubeConfig {
  serverUrl: string;
  token: string;
  username: string | null;
  updatedAt: string;
}

const CONFIG_PATH = path.join(process.cwd(), '.securenexus', 'sonarqube-config.json');

export function sonarqubeConfigPath(): string {
  return CONFIG_PATH;
}

export async function readSonarqubeConfig(): Promise<SonarqubeConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SonarqubeConfig>;
    if (!parsed.serverUrl?.trim() || !parsed.token?.trim()) return null;
    return {
      serverUrl: parsed.serverUrl.trim().replace(/\/$/, ''),
      token: parsed.token.trim(),
      username: parsed.username?.trim() || null,
      updatedAt: parsed.updatedAt ?? '',
    };
  } catch {
    return null;
  }
}

export async function writeSonarqubeConfig(input: {
  serverUrl: string;
  token: string;
  username?: string | null;
}): Promise<SonarqubeConfig> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const config: SonarqubeConfig = {
    serverUrl: input.serverUrl.trim().replace(/\/$/, ''),
    token: input.token.trim(),
    username: input.username?.trim() || null,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return config;
}

export async function clearSonarqubeConfig(): Promise<void> {
  await fs.rm(CONFIG_PATH, { force: true });
}
