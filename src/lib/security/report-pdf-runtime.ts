import { execFile } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { extendedToolPath } from './tool-path-env';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

const WKHTML_DIR = path.join(process.cwd(), '.securenexus', 'wkhtmltopdf');
const WKHTML_BIN = path.join(WKHTML_DIR, 'bin', 'wkhtmltopdf');
const WKHTML_LIB_DIR = path.join(WKHTML_DIR, 'lib');

let installPromise: Promise<void> | null = null;
let chromeLaunchVerified: boolean | null = null;

const LINUX_CHROMIUM_PACKAGES = [
  'chromium-browser',
  'chromium',
  'fonts-liberation',
  'libatk1.0-0',
  'libatk-bridge2.0-0',
  'libcups2',
  'libdrm2',
  'libgbm1',
  'libnss3',
  'libxcomposite1',
  'libxdamage1',
  'libxfixes3',
  'libxkbcommon0',
  'libxrandr2',
  'libasound2',
  'libpango-1.0-0',
  'libcairo2',
  'libgtk-3-0',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'ca-certificates',
  'fontconfig',
  'libjpeg-turbo8',
  'libxrender1',
].join(' ');

const LINUX_WKHTMLTOPDF_PACKAGES = 'wkhtmltopdf xfonts-75dpi xfonts-base';

export function wkhtmltopdfEnv(): NodeJS.ProcessEnv {
  const ldPath = [WKHTML_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return {
    ...process.env,
    PATH: extendedToolPath(),
    LD_LIBRARY_PATH: ldPath,
  };
}

async function hasCommand(command: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: 5000, env: env ?? wkhtmltopdfEnv() });
    return true;
  } catch {
    return false;
  }
}

async function runShell(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', ...env },
  });
  return `${stdout}\n${stderr}`.trim();
}

function chromeCandidates(): string[] {
  return [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
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

export async function resolveWkhtmltopdfBin(): Promise<string | null> {
  if (existsSync(WKHTML_BIN)) return WKHTML_BIN;

  try {
    const { stdout } = await execFileAsync('which', ['wkhtmltopdf'], {
      timeout: 5000,
      env: wkhtmltopdfEnv(),
    });
    const resolved = stdout.trim().split('\n')[0]?.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

export function resetReportPdfRuntimeCache(): void {
  chromeLaunchVerified = null;
}

async function verifyWkhtmltopdfWorks(): Promise<boolean> {
  const bin = await resolveWkhtmltopdfBin();
  if (!bin) return false;
  try {
    await execFileAsync(bin, ['--version'], { timeout: 15000, env: wkhtmltopdfEnv() });
    return true;
  } catch {
    return false;
  }
}

async function verifySystemChromeWorks(): Promise<boolean> {
  const executablePath = resolveChromeExecutable();
  if (!executablePath) return false;
  if (chromeLaunchVerified === true) return true;
  if (chromeLaunchVerified === false) return false;

  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    await browser.close();
    chromeLaunchVerified = true;
    return true;
  } catch {
    chromeLaunchVerified = false;
    return false;
  }
}

export async function isWkhtmltopdfAvailable(): Promise<boolean> {
  return verifyWkhtmltopdfWorks();
}

async function verifyPuppeteerBundledWorks(): Promise<boolean> {
  if (os.platform() !== 'darwin' && os.platform() !== 'win32') return false;
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

export async function isReportPdfExportReady(): Promise<boolean> {
  if (await verifyWkhtmltopdfWorks()) return true;
  if (await verifySystemChromeWorks()) return true;
  if (await verifyPuppeteerBundledWorks()) return true;
  return false;
}

function wkhtmltopdfDebUrls(): string[] {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return [
    `https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.jammy_${arch}.deb`,
    `https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.bullseye_${arch}.deb`,
  ];
}

async function extractDebToDir(debPath: string, extractDir: string): Promise<void> {
  await fs.mkdir(extractDir, { recursive: true });

  if (existsSync('/usr/bin/dpkg-deb')) {
    await runShell(`/usr/bin/dpkg-deb -x "${debPath}" "${extractDir}"`);
    return;
  }
  if (await hasCommand('dpkg-deb', process.env)) {
    await runShell(`dpkg-deb -x "${debPath}" "${extractDir}"`);
    return;
  }

  const workDir = path.join(extractDir, '_ar');
  await fs.mkdir(workDir, { recursive: true });
  await runShell(`cd "${workDir}" && ar x "${debPath}"`);

  const files = await fs.readdir(workDir);
  const dataTar = files.find((file) => file.startsWith('data.tar'));
  if (!dataTar) {
    throw new Error('Could not unpack wkhtmltopdf package.');
  }

  const dataPath = path.join(workDir, dataTar);
  if (dataTar.endsWith('.xz')) {
    await runShell(`tar -xJf "${dataPath}" -C "${extractDir}"`);
  } else if (dataTar.endsWith('.gz')) {
    await runShell(`tar -xzf "${dataPath}" -C "${extractDir}"`);
  } else {
    await runShell(`tar -xf "${dataPath}" -C "${extractDir}"`);
  }
}

async function installWkhtmltopdfLocal(onProgress?: (message: string) => void): Promise<boolean> {
  if (existsSync(WKHTML_BIN)) {
    if (await verifyWkhtmltopdfWorks()) return true;
  }

  onProgress?.('Downloading wkhtmltopdf for PDF export…');
  await fs.mkdir(path.join(WKHTML_DIR, 'bin'), { recursive: true });
  await fs.mkdir(WKHTML_LIB_DIR, { recursive: true });

  for (const url of wkhtmltopdfDebUrls()) {
    const debPath = path.join(WKHTML_DIR, 'wkhtmltox.deb');
    const extractDir = path.join(WKHTML_DIR, 'extract');
    try {
      await runShell(`curl -fsSL -o "${debPath}" "${url}" || wget -qO "${debPath}" "${url}"`);
      const stat = await fs.stat(debPath);
      if (stat.size < 10_000) {
        throw new Error('wkhtmltopdf download was incomplete.');
      }
      await runShell(`rm -rf "${extractDir}"`);
      await extractDebToDir(debPath, extractDir);

      const binCandidates = [
        path.join(extractDir, 'usr', 'local', 'bin', 'wkhtmltopdf'),
        path.join(extractDir, 'usr', 'bin', 'wkhtmltopdf'),
      ];
      const sourceBin = binCandidates.find((candidate) => existsSync(candidate));
      if (!sourceBin) continue;

      await fs.copyFile(sourceBin, WKHTML_BIN);
      await fs.chmod(WKHTML_BIN, 0o755);

      const libCandidates = [
        path.join(extractDir, 'usr', 'local', 'lib'),
        path.join(extractDir, 'usr', 'lib'),
        path.join(extractDir, 'usr', 'lib', 'x86_64-linux-gnu'),
        path.join(extractDir, 'usr', 'lib', 'aarch64-linux-gnu'),
      ];
      for (const libSource of libCandidates) {
        if (!existsSync(libSource)) continue;
        await runShell(`cp -a "${libSource}/." "${WKHTML_LIB_DIR}/"`);
      }

      if (await verifyWkhtmltopdfWorks()) {
        await fs.writeFile(path.join(WKHTML_DIR, '.installed'), new Date().toISOString(), 'utf8');
        return true;
      }
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] local wkhtmltopdf install attempt failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return false;
}

async function installWkhtmltopdfApt(): Promise<boolean> {
  if (!(await hasCommand('apt-get', process.env))) return false;

  try {
    await runShell(
      `sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${LINUX_WKHTMLTOPDF_PACKAGES}`
    );
    if (await verifyWkhtmltopdfWorks()) return true;
  } catch {
    // try deb via sudo
  }

  for (const url of wkhtmltopdfDebUrls()) {
    const debPath = path.join(os.tmpdir(), `wkhtmltox-${Date.now()}.deb`);
    try {
      await runShell(`curl -fsSL -o "${debPath}" "${url}" || wget -qO "${debPath}" "${url}"`);
      await runShell(
        `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${debPath}" || (sudo dpkg -i "${debPath}" && sudo DEBIAN_FRONTEND=noninteractive apt-get install -f -y)`
      );
      if (await verifyWkhtmltopdfWorks()) return true;
    } catch {
      // try next package
    }
  }

  return false;
}

async function installChromiumApt(): Promise<boolean> {
  if (!(await hasCommand('apt-get', process.env))) return false;

  resetReportPdfRuntimeCache();
  try {
    await runShell(
      `sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${LINUX_CHROMIUM_PACKAGES}`
    );
  } catch {
    return false;
  }
  return verifySystemChromeWorks();
}

async function installWkhtmltopdfMac(onProgress?: (message: string) => void): Promise<boolean> {
  if (!(await hasCommand('brew', process.env))) return false;
  onProgress?.('Installing wkhtmltopdf via Homebrew…');
  try {
    await execFileAsync('brew', ['install', 'wkhtmltopdf'], { timeout: INSTALL_TIMEOUT_MS });
  } catch {
    return false;
  }
  return verifyWkhtmltopdfWorks();
}

export async function installReportPdfRuntime(
  onProgress?: (message: string) => void
): Promise<void> {
  resetReportPdfRuntimeCache();

  if (await isReportPdfExportReady()) return;

  const platform = os.platform();

  if (platform === 'linux') {
    onProgress?.('Setting up PDF export (wkhtmltopdf)…');
    try {
      if (await installWkhtmltopdfLocal(onProgress)) return;
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] local wkhtmltopdf install failed:',
        err instanceof Error ? err.message : err
      );
    }

    try {
      if (await installWkhtmltopdfApt()) return;
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] apt wkhtmltopdf install failed:',
        err instanceof Error ? err.message : err
      );
    }

    onProgress?.('Installing Chromium for PDF export…');
    try {
      if (await installChromiumApt()) return;
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] chromium install failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  if (platform === 'darwin') {
    try {
      if (await installWkhtmltopdfMac(onProgress)) return;
    } catch (err) {
      console.warn(
        '[report-pdf-runtime] macOS wkhtmltopdf install failed:',
        err instanceof Error ? err.message : err
      );
    }

    try {
      if (await installWkhtmltopdfLocal(onProgress)) return;
    } catch {
      // continue
    }

    if (await verifyPuppeteerBundledWorks()) return;
  }

  if (await isReportPdfExportReady()) return;

  throw new Error('PDF export could not be set up automatically on this server.');
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
