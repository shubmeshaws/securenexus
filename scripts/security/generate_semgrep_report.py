#!/usr/bin/env python3
"""Run Semgrep and generate SAST Summary Table + Finding Details reports."""

import csv
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from html import escape
from pathlib import Path

RULE_RECOMMENDATIONS = {
    "formatted-sql-query": (
        "Avoid f-string SQL execution. For migration scripts, load SQL from trusted files "
        "and execute via parameterized APIs or a reviewed migration runner; never interpolate "
        "untrusted input into SQL strings."
    ),
    "sqlalchemy-execute-raw-query": (
        "Replace raw SQL string execution with SQLAlchemy text() and bound parameters. "
        "For static migration files, validate file paths and use execute(text(sql)) without "
        "dynamic concatenation."
    ),
    "missing-user-entrypoint": (
        "Add a USER instruction in the Dockerfile before CMD/ENTRYPOINT to run the "
        "application as a non-root user."
    ),
    "missing-user": (
        "Add a USER instruction in the Dockerfile before CMD/ENTRYPOINT to run the "
        "application as a non-root user."
    ),
    "unsafe-formatstring": (
        "Avoid format strings or concatenation with user-controlled input in logging/print "
        "calls — use parameterized logging instead."
    ),
}


def short_rule_id(check_id: str) -> str:
    return check_id.rsplit(".", 1)[-1]


def short_cwe(metadata: dict) -> str:
    cwe = metadata.get("cwe") or []
    if not cwe:
        return "—"
    match = re.search(r"CWE-(\d+)", cwe[0])
    return f"CWE-{match.group(1)}" if match else cwe[0]


def short_owasp(metadata: dict) -> str:
    owasp = metadata.get("owasp") or []
    for item in owasp:
        match = re.search(r"(A\d{2}:\d{4})", item)
        if match and "2021" in item:
            return match.group(1)
    for item in owasp:
        match = re.search(r"(A\d{2}:\d{4})", item)
        if match:
            return match.group(1)
    return "—"


def map_severity(severity: str, metadata: dict) -> str:
    sev = (severity or "INFO").upper()
    impact = str(metadata.get("impact", "")).upper()
    if sev == "ERROR" and impact == "HIGH":
        return "High"
    if sev == "ERROR":
        return "Medium"
    if sev == "WARNING":
        return "Medium"
    return "Low"


def map_issue_bucket(finding: dict) -> str:
    """Bucket for Issue Summary / Issues by Repository tables."""
    sev = (finding.get("extra", {}).get("severity") or "INFO").upper()
    meta = finding.get("extra", {}).get("metadata", {})
    impact = str(meta.get("impact", "")).upper()
    if sev == "ERROR":
        return "Critical" if impact == "HIGH" else "High"
    if sev == "WARNING":
        return "Medium" if impact == "MEDIUM" else "Warning"
    return "Low"


def vulnerability_name(check_id: str) -> str:
    short = short_rule_id(check_id)
    friendly = {
        "formatted-sql-query": "Formatted SQL query",
        "sqlalchemy-execute-raw-query": "SQLAlchemy execute raw query",
        "missing-user-entrypoint": "missing-user-entrypoint",
        "missing-user": "dockerfile.security.missing-user.missing-user",
        "unsafe-formatstring": "Unsafe format string",
    }
    return friendly.get(short, check_id)


def recommendation_for(finding: dict) -> str:
    short = short_rule_id(finding["check_id"])
    if short in RULE_RECOMMENDATIONS:
        return RULE_RECOMMENDATIONS[short]
    message = finding.get("extra", {}).get("message", "").strip()
    return message if message else "Review and remediate per Semgrep rule guidance."


def relative_path(file_path: str, target: Path) -> str:
    try:
        return str(Path(file_path).resolve().relative_to(target.resolve()))
    except ValueError:
        return str(file_path)


def location_string(finding: dict, target: Path) -> str:
    path = relative_path(finding["path"], target)
    line = finding["start"]["line"]
    if path.lower().endswith("dockerfile") or path == "DockerFile":
        return path
    return f"{path}:{line}"


def run_semgrep(target: Path) -> dict:
    cmd = [
        "semgrep",
        "scan",
        "--config=auto",
        "--config=p/security-audit",
        "--config=p/docker",
        "--config=p/python",
        "--json",
        "--quiet",
        str(target),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr or "Semgrep scan failed")
    return json.loads(result.stdout)


def build_sast_rows(findings: list[dict], target: Path, repo_name: str) -> list[dict]:
    repo = repo_name
    rows = []
    for idx, finding in enumerate(findings, start=1):
        meta = finding.get("extra", {}).get("metadata", {})
        rows.append(
            {
                "id": f"S-{idx:03d}",
                "vulnerability": vulnerability_name(finding["check_id"]),
                "severity": map_severity(finding.get("extra", {}).get("severity", "INFO"), meta),
                "repository": repo,
                "location": location_string(finding, target),
                "cwe": short_cwe(meta),
                "owasp": short_owasp(meta),
                "recommendation": recommendation_for(finding),
                "rule_id": finding["check_id"],
                "confidence": str(meta.get("confidence", "—")).upper(),
                "impact": str(meta.get("impact", "—")).upper(),
                "likelihood": str(meta.get("likelihood", "—")).upper(),
            }
        )
    return rows


def severity_class(severity: str) -> str:
    return {
        "Critical": "sev-critical",
        "High": "sev-high",
        "Medium": "sev-medium",
        "Low": "sev-low",
        "Warning": "sev-warning",
    }.get(severity, "sev-low")


def aggregate_issue_counts(findings: list[dict]) -> dict[str, int]:
    counts = {"Critical": 0, "High": 0, "Medium": 0, "Low": 0, "Warning": 0}
    for finding in findings:
        bucket = map_issue_bucket(finding)
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def build_key_observations(rows: list[dict], repo: str) -> list[str]:
    if not rows:
        return ["No SAST findings detected in this scan."]

    observations: list[str] = []

    sql_rows = [
        r
        for r in rows
        if "sql" in r["vulnerability"].lower() or "sql" in r["rule_id"].lower()
    ]
    secret_rows = [
        r
        for r in rows
        if any(k in r["rule_id"].lower() for k in ("secret", "credential", "password", "api-key"))
        or "hardcod" in r["vulnerability"].lower()
    ]
    docker_rows = [
        r
        for r in rows
        if "docker" in r["rule_id"].lower() or "missing-user" in r["rule_id"].lower()
    ]
    high_rows = [r for r in rows if r["severity"] in ("High", "Critical")]

    if sql_rows:
        observations.append(
            f"SQL injection or unsafe query patterns found in {repo} "
            f"({len(sql_rows)} finding{'s' if len(sql_rows) != 1 else ''})."
        )
    if secret_rows:
        observations.append(
            f"Hardcoded secrets or credential patterns detected in {repo} "
            f"({len(secret_rows)} finding{'s' if len(secret_rows) != 1 else ''})."
        )
    if docker_rows:
        observations.append(
            f"Dockerfile security misconfigurations identified in {repo} "
            f"({len(docker_rows)} finding{'s' if len(docker_rows) != 1 else ''})."
        )
    if high_rows:
        observations.append(
            f"{len(high_rows)} high-severity issue{'s' if len(high_rows) != 1 else ''} "
            f"in {repo} require immediate remediation."
        )

    rule_counts: dict[str, int] = {}
    for row in rows:
        rule_counts[row["vulnerability"]] = rule_counts.get(row["vulnerability"], 0) + 1
    for name, count in sorted(rule_counts.items(), key=lambda item: -item[1])[:2]:
        if count > 1:
            observations.append(f'Repeated pattern: "{name}" flagged {count} times across the codebase.')

    medium_rows = [r for r in rows if r["severity"] == "Medium"]
    if medium_rows and len(observations) < 4:
        observations.append(
            f"{len(medium_rows)} medium-severity finding{'s' if len(medium_rows) != 1 else ''} "
            f"should be scheduled for remediation."
        )

    if not observations:
        observations.append(
            f"Review {len(rows)} finding{'s' if len(rows) != 1 else ''} in the detailed SAST summary table below."
        )

    return observations[:6]


def report_styles() -> str:
    return """
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
    .brand-title { font-size: 15px; font-weight: 700; }
    .brand-sub { font-size: 12px; opacity: 0.82; }
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
      margin-top: 8px;
    }
    .observations ul { margin: 0; padding-left: 20px; }
    .observations li { margin-bottom: 8px; }
    .detail-table th, .detail-table td { text-align: left; vertical-align: top; }
    .detail-table tr:nth-child(even) td { background: #f8fafc; }
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
    .sev-high { background: #991b1b; }
    .sev-medium { background: #9a3412; }
    .sev-warning { background: #a16207; }
    .sev-low { background: #166534; }
    .report-footer {
      margin-top: 24px;
      text-align: center;
      font-size: 12px;
      color: #94a3b8;
    }
    """


def build_report_header(
    tool_name: str,
    resource_name: str,
    target_url: str,
    generated: str,
    semgrep_version: str,
) -> str:
    extra_meta = ""
    if target_url:
        extra_meta = f"""
      <div class="meta-item">
        <span class="meta-label">Scanner Version</span>
        <span class="meta-value">Semgrep v{escape(semgrep_version)}</span>
      </div>"""

    return f"""
  <header class="report-header">
    <div class="report-header-top">
      <div class="brand">
        <div class="brand-badge">SN</div>
        <div>
          <div class="brand-title">SecureNexus</div>
          <div class="brand-sub">Security Assessment Platform</div>
        </div>
      </div>
      <div class="scan-badge">SAST</div>
    </div>
    <h1 class="report-title">{escape(tool_name)} · {escape(resource_name)}</h1>
    <p class="report-subtitle">Static Application Security Testing Report</p>
    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-label">Tool</span>
        <span class="meta-value">{escape(tool_name)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Repository</span>
        <span class="meta-value">{escape(target_url or resource_name)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Generated</span>
        <span class="meta-value">{generated}</span>
      </div>
      {extra_meta}
    </div>
  </header>"""


def build_sast_html(
    rows: list[dict],
    findings: list[dict],
    target: Path,
    semgrep_version: str,
    display_name: str = "",
    tool_name: str = "Semgrep CE",
    target_url: str = "",
) -> str:
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    repo = display_name or target.name
    doc_title = f"SAST Report · {tool_name} · {repo} | SecureNexus"
    counts = aggregate_issue_counts(findings)
    total = len(findings)
    critical_high = counts["Critical"] + counts["High"]
    low_info = counts["Low"] + counts["Warning"]
    observations = build_key_observations(rows, repo)
    header = build_report_header(tool_name, repo, target_url, generated, semgrep_version)

    body_rows = []
    for row in rows:
        body_rows.append(
            f"""<tr>
  <td>{escape(row['id'])}</td>
  <td>{escape(row['vulnerability'])}</td>
  <td><span class="badge {severity_class(row['severity'])}">{escape(row['severity'])}</span></td>
  <td>{escape(row['repository'])}</td>
  <td><code>{escape(row['location'])}</code></td>
  <td>{escape(row['cwe'])}</td>
  <td>{escape(row['owasp'])}</td>
  <td>{escape(row['recommendation'])}</td>
</tr>"""
        )

    if not body_rows:
        body_rows.append(
            '<tr><td colspan="8" style="text-align:center;padding:24px;">No findings</td></tr>'
        )

    observation_items = "".join(f"<li>{escape(item)}</li>" for item in observations)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{escape(doc_title)}</title>
  <style>{report_styles()}</style>
</head>
<body>
  <div class="page">
    {header}
    <div class="report-body">

  <h2>Issue Summary</h2>
  <table class="summary-table">
    <thead>
      <tr>
        <th>Total Issues</th>
        <th>Critical / High</th>
        <th>Medium</th>
        <th>Low / Info</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="cell-total">{total}</td>
        <td class="cell-critical-high">{critical_high}</td>
        <td class="cell-medium">{counts['Medium']}</td>
        <td class="cell-low-info">{low_info}</td>
      </tr>
    </tbody>
  </table>

  <h2>Issues by Repository</h2>
  <table>
    <thead>
      <tr>
        <th class="text-left">Repository</th>
        <th class="col-critical">Critical</th>
        <th class="col-high">High</th>
        <th>Medium</th>
        <th>Low</th>
        <th>Warning</th>
        <th>Tool</th>
      </tr>
    </thead>
    <tbody>
      <tr class="row-alt">
        <td class="text-left">{escape(repo)}</td>
        <td class="col-critical">{counts['Critical']}</td>
        <td class="col-high">{counts['High']}</td>
        <td>{counts['Medium']}</td>
        <td>{counts['Low']}</td>
        <td>{counts['Warning']}</td>
        <td>{escape(tool_name)}</td>
      </tr>
    </tbody>
  </table>

  <h3>Key Observations</h3>
  <div class="observations">
    <ul>
      {observation_items}
    </ul>
  </div>

  <h2>3.1 SAST Summary Table</h2>
  <table class="detail-table">
    <thead>
      <tr>
        <th>ID</th>
        <th>Vulnerability</th>
        <th>Severity</th>
        <th>Repository</th>
        <th>Location</th>
        <th>CWE</th>
        <th>OWASP</th>
        <th>Recommendation</th>
      </tr>
    </thead>
    <tbody>
{chr(10).join(body_rows)}
    </tbody>
  </table>
    </div>
    <p class="report-footer">SecureNexus Security · Generated by {escape(tool_name)}</p>
  </div>
</body>
</html>
"""


def build_finding_details_html(rows: list[dict], findings: list[dict], target: Path, semgrep_version: str) -> str:
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body_rows = []
    for idx, (row, finding) in enumerate(zip(rows, findings), start=1):
        meta = finding.get("extra", {}).get("metadata", {})
        body_rows.append(
            f"""<tr>
  <td>{idx}</td>
  <td><strong>{escape(finding.get('extra', {}).get('severity', 'INFO').upper())}</strong></td>
  <td><code>{escape(short_rule_id(finding['check_id']))}</code></td>
  <td><code>{escape(relative_path(finding['path'], target))}</code></td>
  <td>{finding['start']['line']}</td>
  <td>{escape((meta.get('cwe') or ['—'])[0])}</td>
  <td>{escape(short_owasp(meta))}</td>
  <td>{escape(row['confidence'])}</td>
  <td>{escape(row['impact'])}</td>
  <td>{escape(row['likelihood'])}</td>
  <td>Security</td>
</tr>"""
        )

    if not body_rows:
        body_rows.append(
            '<tr><td colspan="11" style="text-align:center;padding:24px;">No findings</td></tr>'
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Finding Details – {escape(target.name)}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 32px; color: #1f2937; }}
    h1 {{ font-size: 28px; margin-bottom: 8px; }}
    .meta {{ color: #6b7280; margin-bottom: 24px; font-size: 14px; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
    th, td {{ border: 1px solid #d1d5db; padding: 10px 12px; vertical-align: top; }}
    th {{ background: #f3f4f6; }}
    code {{ background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }}
  </style>
</head>
<body>
  <h1>Finding Details</h1>
  <div class="meta">Repository: <strong>{escape(target.name)}</strong> · Generated: {generated} · Semgrep v{escape(semgrep_version)}</div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Severity</th><th>Rule ID</th><th>File</th><th>Line</th>
        <th>CWE</th><th>OWASP</th><th>Confidence</th><th>Impact</th><th>Likelihood</th><th>Category</th>
      </tr>
    </thead>
    <tbody>
{chr(10).join(body_rows)}
    </tbody>
  </table>
</body>
</html>
"""


def write_csv(path: Path, rows: list[dict]) -> None:
    fieldnames = [
        "id",
        "vulnerability",
        "severity",
        "repository",
        "location",
        "cwe",
        "owasp",
        "recommendation",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row[k] for k in fieldnames})


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    target = target.resolve()
    out_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else target
    display_name = sys.argv[3] if len(sys.argv) > 3 else target.name
    tool_name = sys.argv[4] if len(sys.argv) > 4 else "Semgrep CE"
    target_url = sys.argv[5] if len(sys.argv) > 5 else ""

    data = run_semgrep(target)
    findings = data.get("results", [])
    rows = build_sast_rows(findings, target, display_name)
    version = data.get("version", "unknown")

    sast_html = out_dir / "semgrep_sast_summary.html"
    details_html = out_dir / "semgrep_finding_details.html"
    csv_path = out_dir / "semgrep_sast_summary.csv"
    json_path = out_dir / "semgrep_sast_summary.json"

    sast_html.write_text(
        build_sast_html(rows, findings, target, version, display_name, tool_name, target_url),
        encoding="utf-8",
    )
    details_html.write_text(build_finding_details_html(rows, findings, target, version), encoding="utf-8")
    write_csv(csv_path, rows)
    json_path.write_text(json.dumps({"findings": rows, "raw": data}, indent=2), encoding="utf-8")

    print(f"Findings: {len(findings)}")
    print(f"SAST summary HTML: {sast_html}")
    print(f"SAST summary CSV:  {csv_path}")
    print(f"Finding details:   {details_html}")
    print(f"JSON output:       {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
