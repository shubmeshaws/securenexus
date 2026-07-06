let browserPromise: Promise<import('puppeteer').Browser> | null = null;

async function getBrowser(): Promise<import('puppeteer').Browser> {
  if (!browserPromise) {
    browserPromise = import('puppeteer').then(({ default: puppeteer }) =>
      puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
    );
  }
  return browserPromise;
}

export async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
