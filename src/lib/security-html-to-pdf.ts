import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  ensureReportPdfRuntimeInstalled,
  installReportPdfRuntime,
  isReportPdfExportReady,
  isWkhtmltopdfAvailable,
  resetReportPdfRuntimeCache,
  resolveChromeExecutable,
  resolveWkhtmltopdfBin,
  wkhtmltopdfEnv,
} from './security/report-pdf-runtime';
import os from 'os';

const execFileAsync = promisify(execFile);

let browserPromise: Promise<import('puppeteer').Browser> | null = null;

function resetBrowser(): void {
  browserPromise = null;
}

async function getBrowser(): Promise<import('puppeteer').Browser> {
  const executablePath = resolveChromeExecutable();
  if (!browserPromise) {
    browserPromise = import('puppeteer').then(({ default: puppeteer }) =>
      puppeteer.launch({
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      })
    );
  }
  return browserPromise;
}

async function htmlToPdfWithPuppeteer(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMediaType('screen');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '8mm', bottom: '10mm', left: '8mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

async function htmlToPdfWithWkhtmltopdf(html: string): Promise<Buffer> {
  const bin = await resolveWkhtmltopdfBin();
  if (!bin) throw new Error('wkhtmltopdf is not available.');

  const dir = await mkdtemp(join(tmpdir(), 'securenexus-report-'));
  const htmlPath = join(dir, 'report.html');
  const pdfPath = join(dir, 'report.pdf');

  try {
    await writeFile(htmlPath, html, 'utf8');
    await execFileAsync(
      bin,
      [
        '--quiet',
        '--enable-local-file-access',
        '--print-media-type',
        '--background',
        '--page-size',
        'A4',
        htmlPath,
        pdfPath,
      ],
      { env: wkhtmltopdfEnv(), timeout: 120000 }
    );
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function shouldRetryInstall(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('failed to launch') ||
    normalized.includes('shared libraries') ||
    normalized.includes('libatk') ||
    normalized.includes('wkhtmltopdf') ||
    normalized.includes('chromium') ||
    normalized.includes('not available')
  );
}

async function renderPdf(html: string): Promise<Buffer> {
  const errors: string[] = [];

  if (await isWkhtmltopdfAvailable()) {
    try {
      return await htmlToPdfWithWkhtmltopdf(html);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'wkhtmltopdf failed');
    }
  }

  if (resolveChromeExecutable() || os.platform() === 'darwin' || os.platform() === 'win32') {
    try {
      return await htmlToPdfWithPuppeteer(html);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Chromium PDF failed');
      resetBrowser();
    }
  }

  throw new Error(errors.join('\n') || 'No PDF renderer is available on this server.');
}

export async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  await ensureReportPdfRuntimeInstalled();

  try {
    return await renderPdf(html);
  } catch (firstError) {
    const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
    if (!shouldRetryInstall(firstMessage)) {
      throw new Error(`PDF export failed.\n\n${firstMessage}`);
    }

    resetReportPdfRuntimeCache();
    resetBrowser();
    await installReportPdfRuntime();

    return renderPdf(html);
  }
}
