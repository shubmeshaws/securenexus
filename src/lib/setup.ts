import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import prisma from '@/lib/prisma';
import { SETTING_KEYS } from '@/lib/settings';

const execFileAsync = promisify(execFile);

export interface SetupStatus {
  complete: boolean;
  dbConnected: boolean;
  schemaExists: boolean;
}

async function canConnectToDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function doesSchemaExist(): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'User'
      ) AS "exists"
    `;
    return Boolean(result[0]?.exists);
  } catch {
    return false;
  }
}

async function readSetupCompleteFlag(): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key: SETTING_KEYS.SETUP_COMPLETE },
    });
    return row?.value === 'true';
  } catch {
    return false;
  }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const dbConnected = await canConnectToDatabase();
  if (!dbConnected) {
    return { complete: false, dbConnected: false, schemaExists: false };
  }

  const schemaExists = await doesSchemaExist();
  if (!schemaExists) {
    return { complete: false, dbConnected: true, schemaExists: false };
  }

  const complete = await readSetupCompleteFlag();
  return { complete, dbConnected: true, schemaExists: true };
}

export async function isSetupComplete(): Promise<boolean> {
  const status = await getSetupStatus();
  return status.complete;
}

export async function checkDatabaseConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, message: 'Database connection successful.' };
  } catch (err) {
    let message = err instanceof Error ? err.message : 'Database connection failed';
    if (message.includes('denied access') || message.includes('does not exist')) {
      message += '. Check DATABASE_URL in .env — on macOS Homebrew Postgres the role is usually your username, not "postgres".';
    }
    return { ok: false, message };
  }
}

export async function ensureDatabaseSchema(): Promise<{
  ok: boolean;
  created: boolean;
  message: string;
}> {
  const hadSchema = await doesSchemaExist();

  try {
    const root = process.cwd();
    await execFileAsync('npx', ['prisma', 'db', 'push'], {
      cwd: root,
      env: { ...process.env, HOME: process.env.HOME ?? path.join(root, '.home') },
      timeout: 120_000,
    });

    const schemaReady = await doesSchemaExist();
    if (!schemaReady) {
      return {
        ok: false,
        created: false,
        message: 'Schema sync finished but core tables were not detected.',
      };
    }

    return {
      ok: true,
      created: !hadSchema,
      message: hadSchema
        ? 'Database schema synced with the latest Prisma models.'
        : 'Database schema created successfully.',
    };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: string }).stderr) : '';
    const message =
      err instanceof Error ? `${err.message}${stderr ? `\n${stderr}` : ''}` : 'Schema sync failed';
    return { ok: false, created: false, message };
  }
}

export async function markSetupComplete(): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEYS.SETUP_COMPLETE },
    create: { key: SETTING_KEYS.SETUP_COMPLETE, value: 'true', isSecret: false },
    update: { value: 'true' },
  });
}
