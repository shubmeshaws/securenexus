import { formatTimestampIST } from '@/lib/utils';
import {
  buildReportHeaderHtml,
  categoryReportLabel,
  reportPageStyles,
} from '@/lib/security-report-html';
import type { SecurityResourceView } from '@/lib/security-service';

export interface SonarqubeFindingRow {
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  rule: string;
  title: string;
  location: string;
  message: string;
  type: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityBadgeClass(severity: SonarqubeFindingRow['severity']): string {
  switch (severity) {
    case 'Critical':
      return 'sev-critical';
    case 'High':
      return 'sev-high';
    case 'Medium':
      return 'sev-medium';
    default:
      return 'sev-low';
  }
}

export function buildSonarqubeReportHtml(input: {
  resource: SecurityResourceView;
  toolName: string;
  title: string;
  summary: string;
  findings: SonarqubeFindingRow[];
  scannerVersion: string;
  serverUrl: string;
  projectKey: string;
}): string {
  const { resource, toolName, title, summary, findings, scannerVersion, serverUrl, projectKey } =
    input;
  const generatedAt = formatTimestampIST(new Date().toISOString());
  const targetLabel = resource.type === 'target_url' ? 'URL Target' : 'Repository';
  const targetValue =
    resource.type === 'repository'
      ? `${resource.repoUrl ?? '—'}${resource.defaultBranch ? ` (${resource.defaultBranch})` : ''}`
      : resource.targetUrl ?? '—';

  const order: SonarqubeFindingRow['severity'][] = ['Critical', 'High', 'Medium', 'Low'];
  const counts = {
    Critical: findings.filter((f) => f.severity === 'Critical').length,
    High: findings.filter((f) => f.severity === 'High').length,
    Medium: findings.filter((f) => f.severity === 'Medium').length,
    Low: findings.filter((f) => f.severity === 'Low').length,
  };

  const sorted = [...findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)
  );

  const rows = sorted.length
    ? sorted
        .map(
          (row, index) => `
      <tr>
        <td>S-${String(index + 1).padStart(3, '0')}</td>
        <td class="col-vulnerability">${escapeHtml(row.title)}</td>
        <td><span class="badge ${severityBadgeClass(row.severity)}">${escapeHtml(row.severity)}</span></td>
        <td>${escapeHtml(resource.name)}</td>
        <td class="col-location"><code>${escapeHtml(row.location)}</code></td>
        <td>${escapeHtml(row.type)}</td>
        <td>${escapeHtml(row.rule)}</td>
        <td>${escapeHtml(row.message)}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="8" style="text-align:center;">No issues reported by SonarQube for this project.</td></tr>`;

  const header = buildReportHeaderHtml({
    categoryLabel: categoryReportLabel('sast'),
    toolName: escapeHtml(toolName),
    resourceName: escapeHtml(resource.name),
    subtitle: 'Static application security testing',
    generatedAt: escapeHtml(generatedAt),
    targetLabel,
    targetValue: escapeHtml(targetValue),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    ${reportPageStyles()}
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .sev-critical { background: #7f1d1d; color: #fff; }
    .sev-high { background: #dc2626; color: #fff; }
    .sev-medium { background: #f59e0b; color: #1f2937; }
    .sev-low { background: #dbeafe; color: #1e40af; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0 24px; }
    .summary-card { background: #fff; border: 1px solid #dbe3ee; border-radius: 12px; padding: 14px; text-align: center; }
    .summary-card .count { font-size: 24px; font-weight: 700; }
    .meta-line { font-size: 12px; color: #64748b; margin-bottom: 12px; }
    .findings-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .findings-table th, .findings-table td { border: 1px solid #e2e8f0; padding: 8px 10px; vertical-align: top; }
    .findings-table th { background: #f8fafc; text-align: left; }
    .col-vulnerability { min-width: 180px; }
    .col-location { min-width: 140px; }
  </style>
</head>
<body>
  <div class="page">
    ${header}
    <div class="report-body">
      <div class="summary-box">${escapeHtml(summary)}</div>
      <p class="meta-line">SonarQube server: <code>${escapeHtml(serverUrl)}</code> · Project key: <code>${escapeHtml(projectKey)}</code> · Scanner: ${escapeHtml(scannerVersion)}</p>
      <div class="summary-grid">
        <div class="summary-card"><div class="count">${counts.Critical}</div><div>Critical</div></div>
        <div class="summary-card"><div class="count">${counts.High}</div><div>High</div></div>
        <div class="summary-card"><div class="count">${counts.Medium}</div><div>Medium</div></div>
        <div class="summary-card"><div class="count">${counts.Low}</div><div>Low</div></div>
      </div>
      <h2>SAST Summary Table</h2>
      <table class="findings-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Vulnerability</th>
            <th>Severity</th>
            <th>Repository</th>
            <th>Location</th>
            <th>Type</th>
            <th>Rule</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="report-footer">SecureNexus Security · Generated by ${escapeHtml(toolName)}</p>
  </div>
</body>
</html>`;
}
