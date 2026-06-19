import type { SecurityToolCategory } from './security-tools';

export function categoryReportLabel(category: SecurityToolCategory): string {
  const labels: Record<SecurityToolCategory, string> = {
    sast: 'SAST',
    sca: 'SCA',
    dast: 'DAST',
    iac: 'IaC Security',
    secrets: 'Secrets',
  };
  return labels[category];
}

export function categoryReportSubtitle(category: SecurityToolCategory): string {
  const subtitles: Record<SecurityToolCategory, string> = {
    sast: 'Static Application Security Testing Report',
    sca: 'Software Composition Analysis Report',
    dast: 'Dynamic Application Security Testing Report',
    iac: 'Infrastructure as Code Security Report',
    secrets: 'Secrets Detection Report',
  };
  return subtitles[category];
}

export function buildReportDocumentTitle(
  category: SecurityToolCategory,
  toolName: string,
  resourceName: string
): string {
  return `${categoryReportLabel(category)} Report · ${toolName} · ${resourceName} | SecureNexus`;
}

export function reportPageStyles(): string {
  return `
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #eef2f7;
      color: #1e293b;
      margin: 0;
      line-height: 1.5;
    }
    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 24px 40px;
    }
    .report-header {
      background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
      color: #fff;
      border-radius: 16px;
      padding: 24px 28px;
      margin-bottom: 24px;
      box-shadow: 0 10px 30px rgba(37, 99, 235, 0.18);
    }
    .report-header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-badge {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: rgba(255,255,255,0.16);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .brand-title {
      font-size: 15px;
      font-weight: 700;
    }
    .brand-sub {
      font-size: 12px;
      opacity: 0.82;
    }
    .scan-badge {
      background: rgba(255,255,255,0.14);
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 999px;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .report-title {
      margin: 0 0 6px;
      font-size: 28px;
      line-height: 1.2;
      font-weight: 700;
    }
    .report-subtitle {
      margin: 0 0 18px;
      font-size: 14px;
      opacity: 0.88;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .meta-item {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .meta-label {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.75;
      margin-bottom: 4px;
    }
    .meta-value {
      display: block;
      font-size: 14px;
      font-weight: 600;
      word-break: break-word;
    }
    .report-body {
      background: #f8fafc;
      border: 1px solid #dbe3ee;
      border-radius: 16px;
      padding: 24px;
    }
    h2 {
      font-size: 18px;
      margin: 0 0 10px;
      color: #0f172a;
    }
    h2:not(:first-child) { margin-top: 28px; }
    h3 {
      font-size: 16px;
      margin: 24px 0 8px;
      color: #0f172a;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      background: #fff;
      margin-bottom: 8px;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 10px 12px;
      vertical-align: middle;
      text-align: center;
    }
    th {
      background: #4472c4;
      color: #fff;
      font-weight: 600;
    }
    .text-left { text-align: left; }
    .summary-table th, .summary-table td { font-size: 15px; font-weight: 600; }
    .cell-total { background: #dbeafe; color: #1d4ed8; }
    .cell-critical-high { background: #fee2e2; color: #b91c1c; }
    .cell-medium { background: #fef3c7; color: #b45309; }
    .cell-low-info { background: #dcfce7; color: #15803d; }
    .col-critical { background: #fef2f2; }
    .col-high { background: #fff1f2; }
    .row-alt td { background: #eff6ff; }
    .observations {
      background: #fff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 16px 20px;
    }
    .observations ul { margin: 0; padding-left: 20px; }
    .observations li { margin-bottom: 8px; }
    .detail-table th, .detail-table td { text-align: left; vertical-align: top; }
    .detail-table tr:nth-child(even) td { background: #f8fafc; }
    .findings-table th, .findings-table td { text-align: left; vertical-align: top; }
    .findings-table tr:nth-child(even) td { background: #f8fafc; }
    code {
      color: #334155;
      font-size: 13px;
      word-break: break-all;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 12px;
      color: #fff;
    }
    .sev-critical { background: #7f1d1d; }
    .sev-high { background: #991b1b; color: #fff; font-weight: 600; }
    .sev-medium { background: #9a3412; color: #fff; font-weight: 600; }
    .sev-warning { background: #a16207; }
    .sev-low { background: #166534; color: #2563eb; font-weight: 600; }
    .sev-sca-high { background: #f4a582; color: #7c2d12; font-weight: 700; }
    .sev-sca-moderate { background: #fde9d9; color: #9a3412; font-weight: 700; }
    .sev-sca-low { background: #dcfce7; color: #166534; font-weight: 700; }
    .sca-table th, .sca-table td { font-size: 13px; }
    .sca-table .text-left { text-align: left; }
    .sca-table tr.row-alt td { background: #eff6ff; }
    .sca-table tr:not(.row-alt) td { background: #fff; }
    .summary-box {
      background: #fff;
      border: 1px solid #dbe3ee;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 18px;
      color: #475569;
      font-size: 14px;
    }
    .report-footer {
      margin-top: 24px;
      text-align: center;
      font-size: 12px;
      color: #94a3b8;
    }
  `;
}

export function buildReportHeaderHtml(input: {
  categoryLabel: string;
  toolName: string;
  resourceName: string;
  subtitle: string;
  generatedAt: string;
  targetLabel: string;
  targetValue: string;
  extraMeta?: { label: string; value: string };
}): string {
  const extraMeta = input.extraMeta
    ? `<div class="meta-item">
        <span class="meta-label">${input.extraMeta.label}</span>
        <span class="meta-value">${input.extraMeta.value}</span>
      </div>`
    : '';

  return `
  <header class="report-header">
    <div class="report-header-top">
      <div class="brand">
        <div class="brand-badge">SN</div>
        <div>
          <div class="brand-title">SecureNexus</div>
          <div class="brand-sub">Security Assessment Platform</div>
        </div>
      </div>
      <div class="scan-badge">${input.categoryLabel}</div>
    </div>
    <h1 class="report-title">${input.toolName} · ${input.resourceName}</h1>
    <p class="report-subtitle">${input.subtitle}</p>
    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-label">Tool</span>
        <span class="meta-value">${input.toolName}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">${input.targetLabel}</span>
        <span class="meta-value">${input.targetValue}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Generated</span>
        <span class="meta-value">${input.generatedAt}</span>
      </div>
      ${extraMeta}
    </div>
  </header>`;
}
