#!/usr/bin/env python3
"""Convert pip-audit JSON into SecureNexus SCA report."""

import json
import re
import sys
from pathlib import Path

from sca_report_common import normalize_severity, write_report_bundle


def extract_cve(vuln: dict) -> str:
    for alias in vuln.get("aliases") or []:
        if re.match(r"CVE-\d{4}-\d+", alias, re.I):
            return alias.upper()
    vuln_id = vuln.get("id") or ""
    if re.match(r"CVE-\d{4}-\d+", vuln_id, re.I):
        return vuln_id.upper()
    if vuln_id:
        return vuln_id
    return "—"


def infer_severity(vuln: dict) -> str:
    raw = vuln.get("severity") or vuln.get("cvss") or ""
    if isinstance(raw, dict):
        score = raw.get("score")
        if isinstance(score, (int, float)):
            if score >= 9:
                return "Critical"
            if score >= 7:
                return "High"
            if score >= 4:
                return "Medium"
            return "Low"
    if isinstance(raw, str) and raw.strip():
        return normalize_severity(raw)
    return "Medium"


def fix_version(vuln: dict) -> str:
    fixes = vuln.get("fix_versions") or []
    if fixes:
        return fixes[0]
    return "—"


def dedupe_rows(rows: list[dict]) -> list[dict]:
    """Collapse duplicate OSV advisories (e.g. GHSA + PYSEC) for the same CVE."""
    severity_rank = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3, "Info": 4, "Unknown": 5}
    merged: dict[tuple[str, str, str], dict] = {}

    for row in rows:
        key = (row["package"].lower(), row["current_ver"], row["cve"])
        prev = merged.get(key)
        if not prev:
            merged[key] = dict(row)
            continue

        if severity_rank.get(row["severity"], 9) < severity_rank.get(prev["severity"], 9):
            prev["severity"] = row["severity"]

        if prev.get("fix_ver") in ("—", "", None) and row.get("fix_ver") not in ("—", "", None):
            prev["fix_ver"] = row["fix_ver"]
            prev["action"] = row["action"]

    return list(merged.values())


def parse_pip_audit(audit_data: dict | list, display_name: str) -> list[dict]:
    rows: list[dict] = []

    if isinstance(audit_data, list):
        dependencies = audit_data
    else:
        dependencies = audit_data.get("dependencies") or []

    for dep in dependencies:
        if not isinstance(dep, dict):
            continue
        pkg_name = dep.get("name") or "unknown"
        pkg_version = dep.get("version") or "—"
        vulns = dep.get("vulns") or []
        if not vulns:
            continue
        for vuln in vulns:
            if not isinstance(vuln, dict):
                continue
            fix_ver = fix_version(vuln)
            rows.append(
                {
                    "package": pkg_name,
                    "current_ver": pkg_version,
                    "fix_ver": fix_ver,
                    "severity": infer_severity(vuln),
                    "cve": extract_cve(vuln),
                    "vulnerability": (vuln.get("description") or vuln.get("id") or f"Advisory for {pkg_name}")[
                        :500
                    ],
                    "action": (
                        f"Upgrade {pkg_name} to {fix_ver}"
                        if fix_ver != "—"
                        else f"Review advisory and upgrade {pkg_name} manually"
                    ),
                    "repository": display_name,
                }
            )

    rows = dedupe_rows(rows)
    severity_order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3, "Info": 4, "Unknown": 5}
    rows.sort(key=lambda r: (severity_order.get(r["severity"], 9), r["package"].lower()))
    for idx, row in enumerate(rows, start=1):
        row["id"] = f"SC-{idx:03d}"
    return rows


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: generate_pip_audit_sca_report.py <pip-audit-report.json> "
            "[output-dir] [display-name] [tool-name] [target-url] [pip-audit-version]"
        )
        return 1

    audit_path = Path(sys.argv[1]).resolve()
    out_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else audit_path.parent
    display_name = sys.argv[3] if len(sys.argv) > 3 else out_dir.name
    tool_name = sys.argv[4] if len(sys.argv) > 4 else "pip-audit"
    target_url = sys.argv[5] if len(sys.argv) > 5 else ""
    scanner_version = sys.argv[6] if len(sys.argv) > 6 else "unknown"

    audit_data = json.loads(audit_path.read_text(encoding="utf-8"))
    rows = parse_pip_audit(audit_data, display_name)

    html_path, json_path = write_report_bundle(
        out_dir,
        "pip_audit",
        rows,
        display_name,
        tool_name,
        target_url,
        scanner_version,
        {"pipAuditVersion": scanner_version, "audit": audit_data},
        version_label="pip-audit",
    )

    print(f"Vulnerabilities: {len(rows)}")
    print(f"SCA summary HTML: {html_path}")
    print(f"JSON output:       {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
