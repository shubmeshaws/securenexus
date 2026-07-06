import PDFDocument from 'pdfkit';
import {
  extractReportTitle,
  parseHtmlTablesByClass,
  parseTableAfterHeading,
  stripHtml,
} from './security-html-parse';

const PAGE_BOTTOM = 52;

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height > doc.page.height - PAGE_BOTTOM) {
    doc.addPage();
  }
}

function renderSectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  ensureSpace(doc, 28);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(text);
  doc.moveDown(0.35);
}

function renderTable(doc: PDFKit.PDFDocument, rows: string[][]): void {
  if (!rows.length) return;

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  rows.forEach((row, rowIndex) => {
    const isHeader = rowIndex === 0;
    ensureSpace(doc, 18);
    doc
      .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(isHeader ? 8 : 7)
      .fillColor(isHeader ? '#1e293b' : '#334155')
      .text(row.join(' | '), doc.page.margins.left, doc.y, {
        width: pageWidth,
        lineGap: 1,
      });
    doc.moveDown(0.15);

    if (isHeader) {
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .strokeColor('#cbd5e1')
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.2);
    }
  });
}

function extractSubtitle(html: string): string | null {
  const match = html.match(/<p[^>]*class="[^"]*report-subtitle[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  return match?.[1] ? stripHtml(match[1]) : null;
}

export function htmlToPdfBuffer(html: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 44, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const title = extractReportTitle(html);
    const subtitle = extractSubtitle(html);

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text(title);
    if (subtitle) {
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(10).fillColor('#64748b').text(subtitle);
    }
    doc.moveDown(0.5);

    const summaryTables = parseHtmlTablesByClass(html, 'summary-table');
    if (summaryTables[0]?.length) {
      renderSectionHeading(doc, 'Issue Summary');
      renderTable(doc, summaryTables[0]);
    }

    const scansIncluded = parseTableAfterHeading(html, 'Scans Included');
    if (scansIncluded.length > 1) {
      renderSectionHeading(doc, 'Scans Included');
      renderTable(doc, scansIncluded);
    }

    const detailTables = parseHtmlTablesByClass(html, 'detail-table');
    detailTables.forEach((table, index) => {
      if (table.length <= 1) return;
      const heading = detailTables.length > 1 ? `Summary Table ${index + 1}` : 'Summary Table';
      renderSectionHeading(doc, heading);
      renderTable(doc, table);
    });

    const footerY = doc.page.height - 36;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#94a3b8')
      .text('SecureNexus Security Report', doc.page.margins.left, footerY, {
        align: 'center',
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      });

    doc.end();
  });
}
