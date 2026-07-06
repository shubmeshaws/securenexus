import fs from 'fs/promises';
import { parseTableInnerHtml } from '@/lib/security-html-parse';
import type { DastFindingRow } from '@/lib/security-report-export';

interface ZapJsonAlert {
  pluginid?: string;
  alert?: string;
  name?: string;
  riskcode?: string;
  confidence?: string;
  riskdesc?: string;
  desc?: string;
  uri?: string;
  instances?: Array<{ uri?: string; method?: string; param?: string }>;
}

interface ZapJsonSite {
  '@name'?: string;
  alerts?: ZapJsonAlert[];
}

interface ZapJsonReport {
  site?: ZapJsonSite[];
}

function mapZapRiskCode(riskcode: string | undefined, riskdesc: string | undefined): string {
  const code = Number.parseInt(riskcode ?? '', 10);
  if (code >= 3) return 'High';
  if (code === 2) return 'Medium';
  if (code === 1) return 'Low';
  if (code === 0) return 'Low';

  const desc = (riskdesc ?? '').toLowerCase();
  if (desc.includes('high')) return 'High';
  if (desc.includes('medium')) return 'Medium';
  if (desc.includes('low')) return 'Low';
  if (desc.includes('info')) return 'Low';
  return 'Medium';
}

function mapRiskLabel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes('high')) return 'High';
  if (normalized.includes('medium')) return 'Medium';
  if (normalized.includes('low')) return 'Low';
  if (normalized.includes('info')) return 'Low';
  return 'Medium';
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseZapJsonReport(raw: unknown): DastFindingRow[] {
  const report = raw as ZapJsonReport;
  const sites = Array.isArray(report?.site) ? report.site : [];
  const findings: DastFindingRow[] = [];
  let index = 0;

  for (const site of sites) {
    const alerts = Array.isArray(site.alerts) ? site.alerts : [];
    for (const alert of alerts) {
      const severity = mapZapRiskCode(alert.riskcode, alert.riskdesc);
      const rule = alert.pluginid?.trim() || 'zap-alert';
      const title = alert.name?.trim() || alert.alert?.trim() || 'Security alert';
      const uri =
        alert.instances?.[0]?.uri?.trim() ||
        alert.uri?.trim() ||
        site['@name']?.trim() ||
        '—';
      const description = stripHtmlTags(alert.desc?.trim() || title);
      const confidence = alert.confidence?.trim() || alert.riskdesc?.trim() || '';

      index += 1;
      findings.push({
        id: `D-${String(index).padStart(3, '0')}`,
        severity,
        rule: `zap:${rule}`,
        location: uri,
        message: confidence ? `${title} — ${description} (${confidence})` : `${title} — ${description}`,
        confidence,
      });
    }
  }

  return sortFindings(findings);
}

function sortFindings(findings: DastFindingRow[]): DastFindingRow[] {
  return [...findings].sort((a, b) => {
    const rank = (value: string) =>
      value === 'High' ? 0 : value === 'Medium' ? 1 : value === 'Low' ? 2 : 3;
    return rank(a.severity) - rank(b.severity);
  });
}

function dedupeFindings(findings: DastFindingRow[]): DastFindingRow[] {
  const seen = new Set<string>();
  const unique: DastFindingRow[] = [];
  for (const row of findings) {
    const key = `${row.rule}|${row.location}|${row.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique.map((row, index) => ({
    ...row,
    id: `D-${String(index + 1).padStart(3, '0')}`,
  }));
}

function parseLabelValueAlertTables(html: string): DastFindingRow[] {
  const findings: DastFindingRow[] = [];
  const markers = ['Alert Detail', 'Alert Details', 'alertdetails'];
  let slice = html;
  for (const marker of markers) {
    const idx = html.search(new RegExp(marker, 'i'));
    if (idx >= 0) {
      slice = html.slice(idx);
      break;
    }
  }

  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  let current: {
    severity?: string;
    description?: string;
    name?: string;
    location?: string;
    pluginId?: string;
    cwe?: string;
  } = {};

  const flush = () => {
    if (!current.description && !current.name && !current.location) {
      current = {};
      return;
    }
    findings.push({
      id: `D-${String(findings.length + 1).padStart(3, '0')}`,
      severity: current.severity ?? 'Medium',
      rule: current.pluginId
        ? `zap:${current.pluginId}`
        : current.cwe
          ? `zap:cwe-${current.cwe}`
          : 'zap:alert',
      location: current.location ?? '—',
      message: current.name
        ? current.description
          ? `${current.name} — ${current.description}`
          : current.name
        : (current.description ?? 'Security alert'),
    });
    current = {};
  };

  while ((tableMatch = tableRegex.exec(slice)) !== null) {
    const rows = parseTableInnerHtml(tableMatch[1]);
    for (const row of rows) {
      if (row.length < 2) continue;
      const label = row[0].trim();
      const value = row.slice(1).join(' ').trim();
      if (!label || !value) continue;

      const lower = label.toLowerCase();
      if (lower === 'risk') {
        if (current.description || current.location || current.name) flush();
        current.severity = mapRiskLabel(value);
      } else if (lower === 'description' || lower === 'alert') {
        current.description = value;
      } else if (lower === 'name') {
        current.name = value;
      } else if (lower === 'url' || lower === 'uri') {
        current.location = value;
      } else if (lower.includes('cwe')) {
        current.cwe = value.replace(/[^\d]/g, '');
      } else if (lower.includes('plugin')) {
        current.pluginId = value.replace(/[^\d]/g, '');
      }
    }
    flush();
  }

  return findings;
}

function parseRiskHeadingAlerts(html: string): DastFindingRow[] {
  const findings: DastFindingRow[] = [];
  const sectionRegex =
    /<h[23][^>]*class="[^"]*risk-([0-3])[^"]*"[^>]*>([\s\S]*?)<\/h[23]>([\s\S]*?)(?=<h[23]|$)/gi;
  let sectionMatch: RegExpExecArray | null;

  while ((sectionMatch = sectionRegex.exec(html)) !== null) {
    const riskCode = sectionMatch[1];
    const severity =
      riskCode === '3' ? 'High' : riskCode === '2' ? 'Medium' : riskCode === '1' ? 'Low' : 'Low';
    const sectionHtml = sectionMatch[3];
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tableMatch: RegExpExecArray | null;

    while ((tableMatch = tableRegex.exec(sectionHtml)) !== null) {
      const rows = parseTableInnerHtml(tableMatch[1]);
      if (rows.length < 2) continue;

      const header = rows[0].map((cell) => cell.toLowerCase());
      const nameIdx = header.findIndex((cell) => cell.includes('alert') || cell.includes('name'));
      const urlIdx = header.findIndex((cell) => cell.includes('url'));
      const descIdx = header.findIndex((cell) => cell.includes('description'));

      for (const row of rows.slice(1)) {
        const name =
          (nameIdx >= 0 ? row[nameIdx] : row[0])?.trim() ||
          row.find((cell) => cell.length > 0)?.trim();
        const location = urlIdx >= 0 ? row[urlIdx]?.trim() : row[1]?.trim();
        const description = descIdx >= 0 ? row[descIdx]?.trim() : row.slice(2).join(' ').trim();
        if (!name || /^number of alerts$/i.test(name)) continue;

        findings.push({
          id: `D-${String(findings.length + 1).padStart(3, '0')}`,
          severity,
          rule: 'zap:alert',
          location: location || '—',
          message: description ? `${name} — ${description}` : name,
        });
      }
    }
  }

  return findings;
}

function parseSummaryAlertCounts(html: string): number {
  const summaryIdx = html.search(/Summary of Alerts/i);
  if (summaryIdx < 0) return 0;

  const slice = html.slice(summaryIdx, summaryIdx + 4000);
  const rows = parseTableInnerHtml(slice.match(/<table[^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? '');
  let total = 0;

  for (const row of rows.slice(1)) {
    const count = Number.parseInt(row[row.length - 1]?.replace(/[^\d]/g, '') ?? '', 10);
    if (Number.isFinite(count)) total += count;
  }

  return total;
}

export function parseZapHtmlReport(html: string): DastFindingRow[] {
  const trimmed = html.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    try {
      return parseZapJsonReport(JSON.parse(trimmed) as unknown);
    } catch {
      return [];
    }
  }

  const labelValueFindings = parseLabelValueAlertTables(html);
  const headingFindings =
    labelValueFindings.length > 0 ? [] : parseRiskHeadingAlerts(html);
  const combined = dedupeFindings([...labelValueFindings, ...headingFindings]);

  if (combined.length > 0) return sortFindings(combined);

  const linkFindings: DastFindingRow[] = [];
  const linkRegex = /href="[^"]*alert\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const title = stripHtmlTags(linkMatch[2]);
    if (!title) continue;
    linkFindings.push({
      id: `D-${String(linkFindings.length + 1).padStart(3, '0')}`,
      severity: 'Medium',
      rule: `zap:${linkMatch[1]}`,
      location: '—',
      message: title,
    });
  }

  return sortFindings(dedupeFindings(linkFindings));
}

export function parseZapHtmlSeverityCounts(html: string): {
  high: number;
  medium: number;
  low: number;
} {
  const summaryIdx = html.search(/Summary of Alerts/i);
  if (summaryIdx < 0) return { high: 0, medium: 0, low: 0 };

  const slice = html.slice(summaryIdx, summaryIdx + 4000);
  const rows = parseTableInnerHtml(slice.match(/<table[^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? '');
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const row of rows.slice(1)) {
    if (row.length < 2) continue;
    const risk = row[0].toLowerCase();
    const count = Number.parseInt(row[row.length - 1]?.replace(/[^\d]/g, '') ?? '', 10);
    if (!Number.isFinite(count)) continue;
    if (risk.includes('high')) high += count;
    else if (risk.includes('medium')) medium += count;
    else if (risk.includes('low') || risk.includes('info')) low += count;
  }

  return { high, medium, low };
}

export function zapHtmlSummaryTotal(html: string): number {
  return parseSummaryAlertCounts(html);
}

export async function readZapReportFile(reportPath: string): Promise<{
  content: string;
  findings: DastFindingRow[];
  summaryTotal: number;
}> {
  const content = await fs.readFile(reportPath, 'utf-8');
  if (!content.trim()) {
    return { content, findings: [], summaryTotal: 0 };
  }

  if (reportPath.endsWith('.json') || content.trim().startsWith('{')) {
    const findings = parseZapJsonReport(JSON.parse(content) as unknown);
    return { content, findings, summaryTotal: findings.length };
  }

  const findings = parseZapHtmlReport(content);
  return { content, findings, summaryTotal: zapHtmlSummaryTotal(content) };
}
