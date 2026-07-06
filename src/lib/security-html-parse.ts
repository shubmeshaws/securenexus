function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

export function isPlaceholderTableRow(row: string[]): boolean {
  const joined = row.join(' ').toLowerCase();
  return (
    joined.includes('no findings') ||
    joined.includes('no secrets detected') ||
    joined.includes('no vulnerable dependencies') ||
    joined.includes('no vulnerabilities found')
  );
}

export function parseTableInnerHtml(inner: string): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(inner)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

export function cleanDetailTableRows(rows: string[][]): string[][] {
  if (!rows.length) return [];
  const header = rows[0];
  const dataRows = rows.slice(1).filter((row) => !isPlaceholderTableRow(row));
  return [header, ...dataRows];
}

export function parseHtmlTablesByClass(html: string, className: string): string[][][] {
  const tables: string[][][] = [];
  const regex = new RegExp(`<table[^>]*\\b${className}\\b[^>]*>([\\s\S]*?)<\\/table>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const rows = parseTableInnerHtml(match[1]);
    if (rows.length) tables.push(rows);
  }
  return tables;
}

export function parseTableAfterHeading(html: string, heading: string): string[][] {
  const markerIndex = html.indexOf(heading);
  if (markerIndex < 0) return [];

  const slice = html.slice(markerIndex);
  const tableMatch = slice.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch?.[1]) return [];
  return parseTableInnerHtml(tableMatch[1]);
}

export interface DetailTableSection {
  heading: string;
  reportType: string;
  rows: string[][];
}

function inferReportType(heading: string): string {
  const normalized = heading.toLowerCase();
  if (normalized.includes('sca')) return 'SCA';
  if (normalized.includes('sast')) return 'SAST';
  if (normalized.includes('secrets')) return 'Secrets';
  if (normalized.includes('iac')) return 'IaC';
  if (normalized.includes('dast')) return 'DAST';
  return 'Summary';
}

export function extractDetailTableFromBlock(block: string): DetailTableSection | null {
  const match = block.match(
    /<h2[^>]*>([^<]*Summary Table[^<]*)<\/h2>\s*<table[^>]*\bdetail-table\b[^>]*>([\s\S]*?)<\/table>/i
  );
  if (!match?.[1] || !match[2]) return null;

  const heading = stripHtml(match[1]);
  const rows = cleanDetailTableRows(parseTableInnerHtml(match[2]));
  if (!rows.length) return null;

  return {
    heading,
    reportType: inferReportType(heading),
    rows,
  };
}

export function parseDetailTableSections(html: string): DetailTableSection[] {
  if (html.includes('merged-section')) {
    const sections: DetailTableSection[] = [];
    const sectionRegex = /<section[^>]*class="[^"]*merged-section[^"]*"[^>]*>([\s\S]*?)<\/section>/gi;
    let sectionMatch: RegExpExecArray | null;
    while ((sectionMatch = sectionRegex.exec(html)) !== null) {
      const parsed = extractDetailTableFromBlock(sectionMatch[1]);
      if (parsed) sections.push(parsed);
    }
    return sections;
  }

  const parsed = extractDetailTableFromBlock(html);
  return parsed ? [parsed] : [];
}

export function extractReportTitle(html: string): string {
  const h1Match = html.match(/<h1[^>]*class="[^"]*report-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) return stripHtml(h1Match[1]);

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return stripHtml(titleMatch[1]).replace(/\s*\|\s*SecureNexus.*$/i, '');

  return 'Security Report';
}
