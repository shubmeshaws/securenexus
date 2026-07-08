import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import {
  SONAR_SCANNER_DOWNLOAD_BASE,
  SONAR_SCANNER_VERSION,
} from './sonarqube-constants';

const execFileAsync = promisify(execFile);

export const SONAR_SCANNER_SYSTEM_DIR = '/opt/sonar-scanner';
export const SONAR_SCANNER_LOCAL_DIR = path.join(process.cwd(), '.securenexus', 'sonar-scanner');

export function scannerZipName(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? `sonar-scanner-cli-${SONAR_SCANNER_VERSION}-macosx-aarch64.zip`
      : `sonar-scanner-cli-${SONAR_SCANNER_VERSION}-macosx-x64.zip`;
  }
  return `sonar-scanner-cli-${SONAR_SCANNER_VERSION}-linux-x64.zip`;
}

export function extractedDirName(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? `sonar-scanner-${SONAR_SCANNER_VERSION}-macosx-aarch64`
      : `sonar-scanner-${SONAR_SCANNER_VERSION}-macosx-x64`;
  }
  return `sonar-scanner-${SONAR_SCANNER_VERSION}-linux-x64`;
}

export function sonarScannerDownloadUrl(): string {
  return `${SONAR_SCANNER_DOWNLOAD_BASE}/${scannerZipName()}`;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSonarScannerBin(): Promise<string | null> {
  const candidates = [
    path.join(SONAR_SCANNER_SYSTEM_DIR, 'bin', 'sonar-scanner'),
    path.join(SONAR_SCANNER_LOCAL_DIR, 'bin', 'sonar-scanner'),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  return null;
}

export async function isSonarScannerAvailable(): Promise<boolean> {
  return (await resolveSonarScannerBin()) !== null;
}

export async function readSonarScannerVersion(): Promise<string | null> {
  const bin = await resolveSonarScannerBin();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, ['-v'], { timeout: 15_000 });
    const line = stdout.trim().split('\n').find((row) => /sonar-scanner/i.test(row));
    return line?.trim() || stdout.trim() || null;
  } catch {
    return `sonar-scanner ${SONAR_SCANNER_VERSION}`;
  }
}

export function sonarScannerInstallCommandHint(os: 'ubuntu' | 'linux' | 'macos'): string[] {
  if (os === 'macos') {
    return [
      'SecureNexus downloads sonar-scanner-cli into .securenexus/sonar-scanner',
      'Or install manually to /opt/sonar-scanner and add bin/ to PATH',
    ];
  }

  return [
    'cd /opt',
    `sudo wget ${sonarScannerDownloadUrl()}`,
    `sudo unzip ${scannerZipName()}`,
    `sudo mv ${extractedDirName()} sonar-scanner`,
    "echo 'export PATH=$PATH:/opt/sonar-scanner/bin' | sudo tee /etc/profile.d/sonar-scanner.sh",
    'source /etc/profile.d/sonar-scanner.sh',
    'sonar-scanner -v',
  ];
}
