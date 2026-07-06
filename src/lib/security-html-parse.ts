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

export function parseHtmlTablesByClass(html: string, className: string): string[][][] {
  const tables: string[][][] = [];
  const regex = new RegExp(`<table[^>]*\\b${className}\\b[^>]*>([\\s\\S]*?)<\\/table>`, 'gi');
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

export function extractReportTitle(html: string): string {
  const h1Match = html.match(/<h1[^>]*class="[^"]*report-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) return stripHtml(h1Match[1]);

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return stripHtml(titleMatch[1]).replace(/\s*\|\s*SecureNexus.*$/i, '');

  return 'Security Report';
}
