import { formatTimestampIST } from './utils';
import { reportPageStyles } from './security-report-html';
import type { SecurityToolCategory } from './security-tools';

export interface MergedReportSection {
  title: string;
  toolName: string;
  resourceName: string;
  category: SecurityToolCategory;
  categoryLabel: string;
  summary: string;
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractReportBody(html: string): string {
  const match = html.match(/<div class="report-body">([\s\S]*?)<\/div>\s*(?:<p class="report-footer"|$)/i);
  if (match?.[1]) return match[1].trim();

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch?.[1]?.trim() ?? html;
}

export function buildMergedSecurityReportHtml(sections: MergedReportSection[]): string {
  const generatedAt = formatTimestampIST(new Date().toISOString());
  const totalHigh = sections.reduce((sum, row) => sum + row.highCount, 0);
  const totalMedium = sections.reduce((sum, row) => sum + row.mediumCount, 0);
  const totalLow = sections.reduce((sum, row) => sum + row.lowCount, 0);
  const totalIssues = totalHigh + totalMedium + totalLow;
  const resourceNames = Array.from(new Set(sections.map((row) => row.resourceName)));
  const toolNames = Array.from(new Set(sections.map((row) => row.toolName)));
  const categories = Array.from(new Set(sections.map((row) => row.categoryLabel)));

  const overviewRows = sections
    .map(
      (row, index) => `
      <tr class="${index % 2 === 0 ? 'row-alt' : ''}">
        <td class="text-left">${escapeHtml(row.resourceName)}</td>
        <td class="text-left">${escapeHtml(row.toolName)}</td>
        <td>${escapeHtml(row.categoryLabel)}</td>
        <td class="col-high">${row.highCount}</td>
        <td>${row.mediumCount}</td>
        <td>${row.lowCount}</td>
      </tr>`
    )
    .join('');

  const sectionBlocks = sections
    .map(
      (row, index) => `
      <section class="merged-section" id="section-${index + 1}">
        <h2>${index + 1}. ${escapeHtml(row.toolName)} · ${escapeHtml(row.resourceName)}</h2>
        <p class="section-summary">${escapeHtml(row.summary)}</p>
        ${extractReportBody(row.htmlContent)}
      </section>`
    )
    .join('\n');

  const tocItems = sections
    .map(
      (row, index) =>
        `<li><a href="#section-${index + 1}">${escapeHtml(row.toolName)} · ${escapeHtml(row.resourceName)}</a></li>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Combined Security Report | SecureNexus</title>
  <style>
    ${reportPageStyles()}
    .merged-section {
      margin-top: 28px;
      padding-top: 24px;
      border-top: 1px solid #dbe3ee;
    }
    .merged-section:first-of-type {
      margin-top: 0;
      padding-top: 0;
      border-top: none;
    }
    .section-summary {
      background: #fff;
      border: 1px solid #dbe3ee;
      border-radius: 10px;
      padding: 12px 14px;
      margin: 0 0 16px;
      color: #475569;
      font-size: 13px;
    }
    .toc {
      background: #fff;
      border: 1px solid #dbe3ee;
      border-radius: 10px;
      padding: 14px 18px;
      margin-bottom: 18px;
    }
    .toc ul { margin: 8px 0 0; padding-left: 18px; }
    .toc a { color: #2563eb; text-decoration: none; }
    .toc a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="page">
    <header class="report-header">
      <div class="report-header-top">
        <div class="brand">
          <div class="brand-badge">SN</div>
          <div>
            <div class="brand-title">SecureNexus</div>
            <div class="brand-sub">Security Assessment Platform</div>
          </div>
        </div>
        <div class="scan-badge">COMBINED</div>
      </div>
      <h1 class="report-title">Combined Security Scan Report</h1>
      <p class="report-subtitle">Merged assessment across ${sections.length} scan${sections.length === 1 ? '' : 's'}</p>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">Repositories</span>
          <span class="meta-value">${escapeHtml(resourceNames.join(', '))}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Tools</span>
          <span class="meta-value">${escapeHtml(toolNames.join(', '))}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Scan Types</span>
          <span class="meta-value">${escapeHtml(categories.join(', '))}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Generated</span>
          <span class="meta-value">${escapeHtml(generatedAt)}</span>
        </div>
      </div>
    </header>

    <div class="report-body">
      <h2>Combined Issue Summary</h2>
      <table class="summary-table">
        <thead>
          <tr>
            <th>Total Issues</th>
            <th>High</th>
            <th>Medium</th>
            <th>Low</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="cell-total">${totalIssues}</td>
            <td class="cell-critical-high">${totalHigh}</td>
            <td class="cell-medium">${totalMedium}</td>
            <td class="cell-low-info">${totalLow}</td>
          </tr>
        </tbody>
      </table>

      <h2>Scans Included</h2>
      <table>
        <thead>
          <tr>
            <th class="text-left">Repository</th>
            <th class="text-left">Tool</th>
            <th>Type</th>
            <th class="col-high">High</th>
            <th>Medium</th>
            <th>Low</th>
          </tr>
        </thead>
        <tbody>${overviewRows}</tbody>
      </table>

      <div class="toc">
        <strong>Report sections</strong>
        <ul>${tocItems}</ul>
      </div>

      ${sectionBlocks}
    </div>
    <p class="report-footer">SecureNexus Security · Combined report from ${sections.length} scans</p>
  </div>
</body>
</html>`;
}
