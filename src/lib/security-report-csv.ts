import {
  parseHtmlTablesByClass,
  parseTableAfterHeading,
  parseTableInnerHtml,
  extractReportTitle,
  stripHtml,
} from './security-html-parse';

function csvEscape(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function tableToCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => csvEscape(cell)).join(',')).join('\n');
}

function isPlaceholderRow(row: string[]): boolean {
  const joined = row.join(' ').toLowerCase();
  return (
    joined.includes('no findings') ||
    joined.includes('no secrets detected') ||
    joined.includes('no vulnerable dependencies')
  );
}

function usableDetailTable(rows: string[][]): boolean {
  return rows.length > 1 && !isPlaceholderRow(rows[1] ?? []);
}

export function buildSecurityReportCsv(input: {
  title: string;
  toolNames: string[];
  resourceName: string | null;
  summary: string | null;
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  createdAt: string;
}): string {
  const lines: string[] = [];
  const summaryTables = parseHtmlTablesByClass(input.htmlContent, 'summary-table');
  const detailTables = parseHtmlTablesByClass(input.htmlContent, 'detail-table').filter(usableDetailTable);
  const scansIncluded = parseTableAfterHeading(input.htmlContent, 'Scans Included');

  if (summaryTables[0]?.length) {
    lines.push('Issue Summary');
    lines.push(tableToCsv(summaryTables[0]));
    lines.push('');
  }

  if (scansIncluded.length > 1) {
    lines.push('Scans Included');
    lines.push(tableToCsv(scansIncluded));
    lines.push('');
  }

  if (detailTables.length) {
    detailTables.forEach((table, index) => {
      lines.push(detailTables.length > 1 ? `Summary Table ${index + 1}` : 'Summary Table');
      lines.push(tableToCsv(table));
      if (index < detailTables.length - 1) lines.push('');
    });
    return `${lines.join('\n')}\n`;
  }

  // Fallback: table immediately following a "Summary Table" heading
  const headingMatch = input.htmlContent.match(/<h2[^>]*>([^<]*Summary Table[^<]*)<\/h2>/i);
  if (headingMatch?.index !== undefined) {
    const slice = input.htmlContent.slice(headingMatch.index);
    const tableMatch = slice.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
    if (tableMatch?.[1]) {
      const rows = parseTableInnerHtml(tableMatch[1]);
      if (usableDetailTable(rows)) {
        lines.push(stripHtml(headingMatch[1]));
        lines.push(tableToCsv(rows));
        return `${lines.join('\n')}\n`;
      }
    }
  }

  lines.push('Summary Table');
  lines.push(
    tableToCsv([
      ['Report', 'Tools', 'Resource', 'High', 'Medium', 'Low', 'Created'],
      [
        input.title,
        input.toolNames.join('; '),
        input.resourceName ?? '',
        String(input.highCount),
        String(input.mediumCount),
        String(input.lowCount),
        input.createdAt,
      ],
    ])
  );
  if (input.summary) {
    lines.push('');
    lines.push('Notes');
    lines.push(csvEscape(input.summary));
  }

  return `${lines.join('\n')}\n`;
}
