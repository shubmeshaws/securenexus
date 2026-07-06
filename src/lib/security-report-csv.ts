import { parseDetailTableSections } from './security-html-parse';

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
  const sections = parseDetailTableSections(input.htmlContent);
  if (!sections.length) {
    return 'ID,Message\n,No summary table data found in this report.\n';
  }

  const blocks: string[] = [];
  sections.forEach((section, index) => {
    if (index > 0) blocks.push('');
    blocks.push(section.heading);
    blocks.push(tableToCsv(section.rows));
  });

  return `${blocks.join('\n')}\n`;
}
