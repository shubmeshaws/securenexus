#!/usr/bin/env python3
"""Convert npm audit JSON into SecureNexus SCA report (same layout as SAST)."""

import csv
import json
import re
import sys
from datetime import datetime, timezone
from html import escape
from pathlib import Path


def load_lockfile_versions(lock_path: Path) -> dict[str, str]:
    if not lock_path.exists():
        return {}
    data = json.loads(lock_path.read_text(encoding="utf-8"))
    versions: dict[str, str] = {}

    packages = data.get("packages", {})
    for path, meta in packages.items():
        if not path.startswith("node_modules/") or "version" not in meta:
            continue
        name = path.replace("node_modules/", "", 1)
        if "/node_modules/" in name:
            name = name.rsplit("/node_modules/", 1)[-1]
        versions[name] = meta["version"]

    def walk(deps: dict) -> None:
        for name, meta in deps.items():
            if isinstance(meta, dict) and "version" in meta:
                versions[name] = meta["version"]
                if "dependencies" in meta:
                    walk(meta["dependencies"])

    if "dependencies" in data:
        walk(data["dependencies"])
    return versions


def current_version(pkg_name: str, vuln: dict, lock_versions: dict[str, str]) -> str:
    for node in vuln.get("nodes", []):
        key = node.replace("\\", "/")
        if key in lock_versions:
            return lock_versions[key]
        leaf = key.rsplit("node_modules/", 1)[-1]
        if leaf in lock_versions:
            return lock_versions[leaf]
    if pkg_name in lock_versions:
        return lock_versions[pkg_name]
    rng = vuln.get("range")
    return rng if rng else "—"


def extract_cve(advisory: dict) -> str:
    if advisory.get("cve"):
        return advisory["cve"]
    url = advisory.get("url", "")
    m = re.search(r"CVE-\d{4}-\d+", url, re.I)
    if m:
        return m.group(0).upper()
    m = re.search(r"GHSA-[a-z0-9-]+", url, re.I)
    if m:
        return m.group(0).upper()
    return "—"


def infer_fix_version(advisory: dict, fix_available) -> str:
    if isinstance(fix_available, dict):
        return fix_available.get("version", "—")
    if fix_available is False:
        return "—"

    rng = (advisory.get("range") or "").strip()
    if not rng:
        return "See npm audit fix" if fix_available is True else "—"

    if ">=" in rng and "<=" in rng:
        upper = re.findall(r"<=\s*([0-9][^\s>]*)", rng)
        if upper:
            return f"> {upper[-1]}"

    if re.fullmatch(r"<=\s*[0-9][^\s>]*", rng):
        m = re.search(r"<=\s*([0-9][^\s>]*)", rng)
        if m:
            return f"> {m.group(1)}"

    m = re.search(r"<\s*([0-9][^\s,]*)", rng)
    if m:
        return f">= {m.group(1)}"

    if fix_available is True:
        return "See npm audit fix"
    return "—"


def build_action(fix_available, fix_version: str, pkg_name: str) -> str:
    if fix_available is False:
        return "No automatic fix — review advisory and upgrade manually"
    if isinstance(fix_available, dict):
        ver = fix_available.get("version", fix_version)
        major = fix_available.get("isSemVerMajor")
        if major:
            return f"Upgrade {pkg_name} to {ver} (semver-major — test thoroughly)"
        return f"Upgrade {pkg_name} to {ver} (npm audit fix)"
    if fix_version and fix_version not in ("—", "See npm audit fix"):
        return f"Upgrade {pkg_name} to {fix_version} (npm audit fix)"
    return f"Run npm audit fix for {pkg_name}"


def normalize_severity(severity: str) -> str:
    sev = (severity or "unknown").capitalize()
    if sev == "Moderate":
        return "Medium"
    return sev


def severity_class(severity: str) -> str:
    return {
        "Critical": "sev-critical",
        "High": "sev-high",
        "Medium": "sev-medium",
        "Moderate": "sev-medium",
        "Low": "sev-low",
        "Info": "sev-low",
        "Warning": "sev-warning",
    }.get(normalize_severity(severity), "sev-low")


def parse_audit(audit_data: dict, project_dir: Path, display_name: str) -> list[dict]:
    lock_versions = load_lockfile_versions(project_dir / "package-lock.json")
    rows: list[dict] = []
    vulnerabilities = audit_data.get("vulnerabilities") or {}

    for pkg_name, vuln in sorted(vulnerabilities.items(), key=lambda x: x[0].lower()):
        advisories = [v for v in vuln.get("via", []) if isinstance(v, dict)]
        if not advisories:
            rows.append(
                {
                    "package": pkg_name,
                    "current_ver": current_version(pkg_name, vuln, lock_versions),
                    "fix_ver": infer_fix_version({}, vuln.get("fixAvailable")),
                    "severity": normalize_severity(vuln.get("severity", "")),
                    "cve": "—",
                    "vulnerability": f"Vulnerable dependency: {pkg_name}",
                    "action": build_action(
                        vuln.get("fixAvailable"), infer_fix_version({}, vuln.get("fixAvailable")), pkg_name
                    ),
                    "repository": display_name,
                }
            )
            continue

        for advisory in advisories:
            fix_ver = infer_fix_version(advisory, vuln.get("fixAvailable"))
            rows.append(
                {
                    "package": pkg_name,
                    "current_ver": current_version(pkg_name, vuln, lock_versions),
                    "fix_ver": fix_ver,
                    "severity": normalize_severity(advisory.get("severity") or vuln.get("severity", "")),
                    "cve": extract_cve(advisory),
                    "vulnerability": advisory.get("title") or f"Security advisory for {pkg_name}",
                    "action": build_action(vuln.get("fixAvailable"), fix_ver, pkg_name),
                    "repository": display_name,
                }
            )

    severity_order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3, "Info": 4, "Unknown": 5}
    rows.sort(key=lambda r: (severity_order.get(r["severity"], 9), r["package"].lower()))
    for idx, row in enumerate(rows, start=1):
        row["id"] = f"SC-{idx:03d}"
    return rows


def aggregate_issue_counts(rows: list[dict]) -> dict[str, int]:
    counts = {"Critical": 0, "High": 0, "Medium": 0, "Low": 0, "Warning": 0}
    for row in rows:
        bucket = normalize_severity(row.get("severity", ""))
        if bucket == "Info":
            bucket = "Low"
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def build_key_observations(rows: list[dict], repo: str) -> list[str]:
    if not rows:
        return ["No vulnerable dependencies detected in this scan."]

    observations: list[str] = []
    critical_high = [r for r in rows if r["severity"] in ("Critical", "High")]
    medium_rows = [r for r in rows if r["severity"] == "Medium"]
    fixable = [r for r in rows if r["fix_ver"] not in ("—", "See npm audit fix")]

    if critical_high:
        observations.append(
            f"{len(critical_high)} critical/high severity vulnerabilit"
            f"{'y' if len(critical_high) == 1 else 'ies'} in {repo} require immediate remediation."
        )
    if fixable:
        observations.append(
            f"{len(fixable)} package{'s' if len(fixable) != 1 else ''} have a recommended fix version via npm audit."
        )

    pkg_counts: dict[str, int] = {}
    for row in rows:
        pkg_counts[row["package"]] = pkg_counts.get(row["package"], 0) + 1
    for name, count in sorted(pkg_counts.items(), key=lambda item: -item[1])[:2]:
        if count > 1:
            observations.append(f'Package "{name}" appears {count} times in the vulnerability report.')

    if medium_rows and len(observations) < 4:
        observations.append(
            f"{len(medium_rows)} medium-severity dependenc"
            f"{'y' if len(medium_rows) == 1 else 'ies'} should be scheduled for upgrade."
        )

    if not observations:
        observations.append(
            f"Review {len(rows)} vulnerable dependenc{'y' if len(rows) == 1 else 'ies'} in the SCA summary table below."
        )

    return observations[:6]


SECURENEXUS_BRAND_HTML = """
      <div class="securenexus-brand">
        <div class="securenexus-logo" aria-label="SecureNexus">
          <span class="logo-secure">SECURE</span><span class="logo-nexus">NEXUS</span>
        </div>
        <div class="logo-byline">By DevOps Team</div>
      </div>"""


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
    scanner_version: str,
) -> str:
    extra_meta = ""
    if scanner_version:
        extra_meta = f"""
      <div class="meta-item">
        <span class="meta-label">Scanner Version</span>
        <span class="meta-value">npm v{escape(scanner_version)}</span>
      </div>"""

    return f"""
  <header class="report-header">
    <div class="report-header-top">
      {SECURENEXUS_BRAND_HTML}
      <div class="scan-badge">SCA</div>
    </div>
    <h1 class="report-title">{escape(tool_name)} · {escape(resource_name)}</h1>
    <p class="report-subtitle">Software Composition Analysis Report</p>
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


def build_sca_html(
    rows: list[dict],
    display_name: str,
    tool_name: str,
    target_url: str,
    scanner_version: str,
) -> str:
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    repo = display_name
    doc_title = f"SCA Report · {tool_name} · {repo} | SecureNexus"
    counts = aggregate_issue_counts(rows)
    total = len(rows)
    critical_high = counts["Critical"] + counts["High"]
    low_info = counts["Low"] + counts["Warning"]
    observations = build_key_observations(rows, repo)
    header = build_report_header(tool_name, repo, target_url, generated, scanner_version)

    body_rows = []
    for row in rows:
        body_rows.append(
            f"""<tr>
  <td>{escape(row['id'])}</td>
  <td><code>{escape(row['package'])}</code></td>
  <td>{escape(row['current_ver'])}</td>
  <td>{escape(row['fix_ver'])}</td>
  <td><span class="badge {severity_class(row['severity'])}">{escape(row['severity'])}</span></td>
  <td>{escape(row['cve'])}</td>
  <td>{escape(row['vulnerability'])}</td>
  <td>{escape(row['action'])}</td>
</tr>"""
        )

    if not body_rows:
        body_rows.append(
            '<tr><td colspan="8" style="text-align:center;padding:24px;">No vulnerabilities found</td></tr>'
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
  <table class="repo-table">
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

  <h2>3.1 SCA Summary Table</h2>
  <table class="detail-table">
    <thead>
      <tr>
        <th>ID</th>
        <th>Package</th>
        <th>Current Ver.</th>
        <th>Fix Ver.</th>
        <th>Severity</th>
        <th>CVE</th>
        <th>Vulnerability</th>
        <th>Action</th>
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


def write_csv(path: Path, rows: list[dict]) -> None:
    fields = ["id", "package", "current_ver", "fix_ver", "severity", "cve", "vulnerability", "action"]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: generate_npm_sca_report.py <npm-audit-report.json> "
            "[project-dir] [output-dir] [display-name] [tool-name] [target-url] [npm-version]"
        )
        return 1

    audit_path = Path(sys.argv[1]).resolve()
    project_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else audit_path.parent
    out_dir = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else project_dir
    display_name = sys.argv[4] if len(sys.argv) > 4 else project_dir.name
    tool_name = sys.argv[5] if len(sys.argv) > 5 else "npm audit"
    target_url = sys.argv[6] if len(sys.argv) > 6 else ""
    npm_version = sys.argv[7] if len(sys.argv) > 7 else "unknown"

    audit_data = json.loads(audit_path.read_text(encoding="utf-8"))
    if not audit_data.get("vulnerabilities") and audit_data.get("error"):
        raise SystemExit(f"Invalid audit JSON: {audit_data.get('error', {}).get('summary', 'unknown error')}")

    out_dir.mkdir(parents=True, exist_ok=True)
    rows = parse_audit(audit_data, project_dir, display_name)

    sca_html = out_dir / "npm_sca_summary.html"
    csv_path = out_dir / "npm_sca_summary.csv"
    json_path = out_dir / "npm_sca_summary.json"

    sca_html.write_text(
        build_sca_html(rows, display_name, tool_name, target_url, npm_version),
        encoding="utf-8",
    )
    write_csv(csv_path, rows)
    json_path.write_text(
        json.dumps({"findings": rows, "raw": {"npmVersion": npm_version, "audit": audit_data}}, indent=2),
        encoding="utf-8",
    )

    print(f"Vulnerabilities: {len(rows)}")
    print(f"SCA summary HTML: {sca_html}")
    print(f"SCA summary CSV:  {csv_path}")
    print(f"JSON output:       {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
