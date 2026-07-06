function csvEscape(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseHtmlTableRows(html: string): string[][] {
  const rows: string[][] = [];
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch?.[1]) return rows;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
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

function parseScansIncludedTable(html: string): string[][] {
  const marker = 'Scans Included';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return [];

  const slice = html.slice(markerIndex);
  return parseHtmlTableRows(slice);
}

function parseDetailTable(html: string): string[][] {
  const markerIndex = html.search(/class="[^"]*detail-table[^"]*"/i);
  if (markerIndex < 0) {
    const findingsIndex = html.search(/class="[^"]*findings-table[^"]*"/i);
    if (findingsIndex < 0) return [];
    return parseHtmlTableRows(html.slice(findingsIndex));
  }
  return parseHtmlTableRows(html.slice(markerIndex));
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
  const lines: string[] = [];
  const metadataRows = [
    ['Report', input.title],
    ['Tools', input.toolNames.join('; ')],
    ['Resource', input.resourceName ?? ''],
    ['High', String(input.highCount)],
    ['Medium', String(input.mediumCount)],
    ['Low', String(input.lowCount)],
    ['Created', input.createdAt],
    ['Summary', input.summary ?? ''],
  ];
  lines.push('Field,Value');
  lines.push(...metadataRows.map(([key, value]) => `${csvEscape(key)},${csvEscape(value)}`));

  const scansIncluded = parseScansIncludedTable(input.htmlContent);
  if (scansIncluded.length > 1) {
    lines.push('');
    lines.push('Scans Included');
    lines.push(tableToCsv(scansIncluded));
  }

  const detailRows = parseDetailTable(input.htmlContent);
  if (detailRows.length > 1) {
    lines.push('');
    lines.push('Findings');
    lines.push(tableToCsv(detailRows));
  }

  return `${lines.join('\n')}\n`;
}
