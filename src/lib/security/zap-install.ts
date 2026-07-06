import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const ZAP_VERSION = '2.16.1';
export const ZAP_LINUX_TARBALL = `ZAP_${ZAP_VERSION}_Linux.tar.gz`;
export const ZAP_DOWNLOAD_URL = `https://github.com/zaproxy/zaproxy/releases/download/v${ZAP_VERSION}/${ZAP_LINUX_TARBALL}`;
export const ZAP_SYSTEM_DIR = '/opt/zap';
export const ZAP_LOCAL_DIR = path.join(process.cwd(), '.securenexus', 'zap');

const MAC_ZAP_SH = '/Applications/ZAP.app/Contents/Java/zap.sh';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveZapInstallDir(): Promise<string | null> {
  const systemSh = path.join(ZAP_SYSTEM_DIR, 'zap.sh');
  if (await pathExists(systemSh)) return ZAP_SYSTEM_DIR;

  const localSh = path.join(ZAP_LOCAL_DIR, 'zap.sh');
  if (await pathExists(localSh)) return ZAP_LOCAL_DIR;

  if (await pathExists(MAC_ZAP_SH)) return path.dirname(MAC_ZAP_SH);

  return null;
}

export async function resolveZapSh(): Promise<string> {
  const installDir = await resolveZapInstallDir();
  if (!installDir) {
    throw new Error(
      'OWASP ZAP is not installed. Install ZAP from Security → Tools before running DAST scans.'
    );
  }

  const zapSh = path.join(installDir, 'zap.sh');
  if (!(await pathExists(zapSh))) {
    throw new Error(
      'OWASP ZAP is installed but zap.sh was not found. Reinstall ZAP from Security → Tools.'
    );
  }

  return zapSh;
}

export async function isZapAvailable(): Promise<boolean> {
  return (await resolveZapInstallDir()) !== null;
}

export async function getZapVersion(): Promise<string | null> {
  try {
    const zapSh = await resolveZapSh();
    const installDir = await resolveZapInstallDir();
    if (!installDir) return null;
    const { stdout } = await execFileAsync(zapSh, ['-version'], {
      timeout: 30_000,
      cwd: installDir,
    });
    const line = stdout.trim().split('\n').find((row) => /ZAP/i.test(row));
    return line?.trim() || `ZAP ${ZAP_VERSION}`;
  } catch {
    return `ZAP ${ZAP_VERSION}`;
  }
}
