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
      background: #ffffff;
      color: #0f172a;
      border: 1px solid #dbe3ee;
      border-radius: 16px;
      padding: 28px 32px;
      margin-bottom: 24px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    .report-header-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
    }
    .securenexus-brand { text-align: left; }
    .securenexus-logo {
      font-size: 38px;
      font-weight: 800;
      letter-spacing: 0.04em;
      line-height: 1;
    }
    .logo-secure { color: #0f172a; }
    .logo-nexus {
      background: linear-gradient(90deg, #38bdf8 0%, #2563eb 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: #2563eb;
      -webkit-text-fill-color: transparent;
    }
    .logo-byline {
      margin-top: 8px;
      font-size: 13px;
      font-weight: 500;
      color: #64748b;
      letter-spacing: 0.01em;
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
      background: rgba(37, 99, 235, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #2563eb;
    }
    .brand-title {
      font-size: 15px;
      font-weight: 700;
    }
    .brand-sub {
      font-size: 12px;
      color: #64748b;
    }
    .scan-badge {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1d4ed8;
      border-radius: 999px;
      padding: 8px 16px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .report-title {
      margin: 0 0 8px;
      font-size: 32px;
      line-height: 1.15;
      font-weight: 800;
      color: #0f172a;
    }
    .report-subtitle {
      margin: 0 0 20px;
      font-size: 15px;
      font-weight: 500;
      color: #475569;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .meta-item {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px 12px;
    }
    .meta-label {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      margin-bottom: 4px;
    }
    .meta-value {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #0f172a;
      word-break: break-word;
    }
    .report-body {
      background: #f8fafc;
      border: 1px solid #dbe3ee;
      border-radius: 16px;
      padding: 24px;
    }
    h2 {
      font-size: 22px;
      font-weight: 800;
      margin: 0 0 12px;
      color: #0f172a;
      letter-spacing: -0.01em;
    }
    h2:not(:first-child) { margin-top: 32px; }
    h3 {
      font-size: 18px;
      font-weight: 700;
      margin: 24px 0 10px;
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
    td.col-critical { background: #fef2f2; color: #b91c1c; font-weight: 600; }
    td.col-high { background: #fff1f2; color: #be123c; font-weight: 600; }
    .repo-table th { background: #4472c4; color: #fff; }
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
    .detail-table .col-location code {
      white-space: nowrap;
      word-break: normal;
    }
    .detail-table .col-vulnerability,
    .detail-table .col-rule {
      min-width: 140px;
      max-width: 240px;
      word-break: break-word;
    }
    .detail-table .col-recommendation,
    .detail-table .col-remediation {
      min-width: 220px;
      word-break: break-word;
    }
    .remediation { font-size: 13px; line-height: 1.45; }
    .remediation-summary { margin: 0 0 8px; font-weight: 600; color: #0f172a; }
    .remediation-steps { margin: 0 0 8px; padding-left: 18px; }
    .remediation-steps li { margin-bottom: 4px; }
    .remediation-cmd {
      margin: 0;
      padding: 8px 10px;
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
    }
    .source-url-list {
      margin: 0;
      padding-left: 18px;
      list-style: disc;
    }
    .source-url-list li { margin-bottom: 6px; }
    .source-url-list a {
      color: #2563eb;
      text-decoration: underline;
      word-break: break-all;
    }
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

/** Extra styles injected for wkhtmltopdf / print engines that drop gradients and opacity. */
export function reportPdfCompatibilityStyles(): string {
  return `
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .report-header {
      background-color: #ffffff !important;
      background-image: none !important;
      color: #0f172a !important;
      border: 1px solid #dbe3ee !important;
    }
    .report-header .report-title,
    .report-header .meta-value {
      color: #0f172a !important;
    }
    .report-header .brand-title,
    .report-header .brand-badge {
      color: #2563eb !important;
    }
    .report-header .brand-sub,
    .report-header .report-subtitle,
    .report-header .meta-label,
    .report-header .logo-byline {
      color: #64748b !important;
      opacity: 1 !important;
    }
    .report-header .logo-secure {
      color: #0f172a !important;
      -webkit-text-fill-color: #0f172a !important;
    }
    .report-header .logo-nexus {
      color: #2563eb !important;
      -webkit-text-fill-color: #2563eb !important;
    }
    .report-header .meta-item {
      background-color: #f8fafc !important;
      border: 1px solid #e2e8f0 !important;
    }
    .report-header .brand-badge {
      background-color: #eff6ff !important;
    }
    .report-header .scan-badge {
      background-color: #eff6ff !important;
      border: 1px solid #bfdbfe !important;
      color: #1d4ed8 !important;
    }
    table th {
      background-color: #4472c4 !important;
      color: #ffffff !important;
    }
    .summary-table .cell-total {
      background-color: #dbeafe !important;
      color: #1d4ed8 !important;
    }
    .summary-table .cell-critical-high {
      background-color: #fee2e2 !important;
      color: #b91c1c !important;
    }
    .summary-table .cell-medium {
      background-color: #fef3c7 !important;
      color: #b45309 !important;
    }
    .summary-table .cell-low-info {
      background-color: #dcfce7 !important;
      color: #15803d !important;
    }
    td.col-high {
      background-color: #fff1f2 !important;
      color: #be123c !important;
    }
    td.col-critical {
      background-color: #fef2f2 !important;
      color: #b91c1c !important;
    }
    table th.col-critical,
    table th.col-high {
      background-color: #4472c4 !important;
      color: #ffffff !important;
    }
    .row-alt td { background-color: #eff6ff !important; }
    .remediation-cmd {
      background-color: #0f172a !important;
      color: #e2e8f0 !important;
    }
    .source-url-list a {
      color: #1d4ed8 !important;
      text-decoration: underline !important;
    }
  `;
}

export function injectReportPdfStyles(html: string): string {
  const styles = `<style>${reportPdfCompatibilityStyles()}</style>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${styles}</head>`);
  }
  return `${styles}${html}`;
}

export function buildSecureNexusBrandHtml(): string {
  return `
      <div class="securenexus-brand">
        <div class="securenexus-logo" aria-label="SecureNexus">
          <span class="logo-secure">SECURE</span><span class="logo-nexus">NEXUS</span>
        </div>
        <div class="logo-byline">By DevOps Team</div>
      </div>`;
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
      ${buildSecureNexusBrandHtml()}
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
