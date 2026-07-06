import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  ensureReportPdfRuntimeInstalled,
  isReportPdfExportReady,
  isWkhtmltopdfAvailable,
  resolveChromeExecutable,
} from './security/report-pdf-runtime';

const execFileAsync = promisify(execFile);

let browserPromise: Promise<import('puppeteer').Browser> | null = null;

async function getBrowser(): Promise<import('puppeteer').Browser> {
  if (!browserPromise) {
    browserPromise = import('puppeteer').then(async ({ default: puppeteer }) => {
      const executablePath = resolveChromeExecutable();
      return puppeteer.launch({
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
    });
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
  const dir = await mkdtemp(join(tmpdir(), 'securenexus-report-'));
  const htmlPath = join(dir, 'report.html');
  const pdfPath = join(dir, 'report.pdf');

  try {
    await writeFile(htmlPath, html, 'utf8');
    await execFileAsync('wkhtmltopdf', [
      '--quiet',
      '--enable-local-file-access',
      '--print-media-type',
      '--background',
      '--page-size',
      'A4',
      htmlPath,
      pdfPath,
    ]);
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  if (!(await isReportPdfExportReady())) {
    await ensureReportPdfRuntimeInstalled();
  }

  const errors: string[] = [];

  if (await isWkhtmltopdfAvailable()) {
    try {
      return await htmlToPdfWithWkhtmltopdf(html);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'wkhtmltopdf failed');
    }
  }

  try {
    return await htmlToPdfWithPuppeteer(html);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Puppeteer failed');
  }

  throw new Error(
    `PDF export failed. Enable at least one security tool to auto-install wkhtmltopdf, or install it manually.\n\n${errors.join('\n')}`
  );
}
