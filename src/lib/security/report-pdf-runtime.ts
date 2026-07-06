import { execFile } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

let installPromise: Promise<void> | null = null;

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function runShell(command: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  return `${stdout}\n${stderr}`.trim();
}

function chromeCandidates(): string[] {
  return [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ].filter((value): value is string => Boolean(value));
}

export function resolveChromeExecutable(): string | undefined {
  for (const candidate of chromeCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function puppeteerExecutableExists(): Promise<boolean> {
  try {
    const puppeteer = await import('puppeteer');
    const executablePath = puppeteer.default.executablePath?.();
    return Boolean(executablePath && existsSync(executablePath));
  } catch {
    return false;
  }
}

export async function isWkhtmltopdfAvailable(): Promise<boolean> {
  return hasCommand('wkhtmltopdf');
}

export async function isReportPdfExportReady(): Promise<boolean> {
  if (await isWkhtmltopdfAvailable()) return true;
  if (resolveChromeExecutable()) return true;
  return puppeteerExecutableExists();
}

async function installWkhtmltopdfLinux(): Promise<boolean> {
  if (await hasCommand('apt-get')) {
    await runShell(
      'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wkhtmltopdf'
    );
    return isWkhtmltopdfAvailable();
  }

  if (await hasCommand('dnf')) {
    await runShell('sudo dnf install -y wkhtmltopdf || sudo dnf install -y wkhtmltox');
    return isWkhtmltopdfAvailable();
  }

  if (await hasCommand('yum')) {
    await runShell('sudo yum install -y wkhtmltopdf || sudo yum install -y wkhtmltox');
    return isWkhtmltopdfAvailable();
  }

  return false;
}

async function installChromiumLinux(): Promise<boolean> {
  if (!(await hasCommand('apt-get'))) return false;

  await runShell(
    'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium'
  );
  return Boolean(resolveChromeExecutable());
}

async function installWkhtmltopdfMac(): Promise<boolean> {
  if (!(await hasCommand('brew'))) return false;
  try {
    await execFileAsync('brew', ['install', 'wkhtmltopdf'], { timeout: INSTALL_TIMEOUT_MS });
  } catch {
    return false;
  }
  return isWkhtmltopdfAvailable();
}

export async function installReportPdfRuntime(
  onProgress?: (message: string) => void
): Promise<void> {
  if (await isReportPdfExportReady()) return;

  const platform = os.platform();

  if (platform === 'linux') {
    onProgress?.('Installing wkhtmltopdf for PDF report export…');
    try {
      if (await installWkhtmltopdfLinux()) return;
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] wkhtmltopdf install failed:',
        err instanceof Error ? err.message : err
      );
    }

    onProgress?.('Installing Chromium for PDF report export…');
    try {
      if (await installChromiumLinux()) return;
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] chromium install failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  if (platform === 'darwin') {
    onProgress?.('Installing wkhtmltopdf for PDF report export…');
    try {
      if (await installWkhtmltopdfMac()) return;
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] wkhtmltopdf install failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  if (await puppeteerExecutableExists()) return;

  throw new Error(
    'PDF export runtime is not available. Install wkhtmltopdf or Chromium on this server, or run npm install to use the bundled Puppeteer browser.'
  );
}

export function scheduleReportPdfRuntimeInstall(): void {
  if (installPromise) return;

  installPromise = (async () => {
    try {
      if (await isReportPdfExportReady()) return;
      await installReportPdfRuntime();
    } catch (err) {
      console.error(
        '[report-pdf-runtime] automatic install failed:',
        err instanceof Error ? err.message : err
      );
    } finally {
      installPromise = null;
    }
  })();
}

export async function ensureReportPdfRuntimeInstalled(): Promise<void> {
  if (await isReportPdfExportReady()) return;
  if (installPromise) {
    await installPromise.catch(() => undefined);
    if (await isReportPdfExportReady()) return;
  }
  await installReportPdfRuntime();
}
