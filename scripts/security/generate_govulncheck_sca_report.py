#!/usr/bin/env python3
"""Convert govulncheck JSON stream into SecureNexus SCA report."""

import json
import re
import sys
from pathlib import Path

from sca_report_common import normalize_severity, write_report_bundle


def extract_cve(osv_entry: dict | str) -> str:
    if isinstance(osv_entry, str):
        if re.match(r"GO-\d{4}-\d+", osv_entry, re.I):
            return osv_entry
        if re.match(r"CVE-\d{4}-\d+", osv_entry, re.I):
            return osv_entry.upper()
        return osv_entry or "—"

    for alias in osv_entry.get("aliases") or []:
        if re.match(r"CVE-\d{4}-\d+", alias, re.I):
            return alias.upper()
    osv_id = osv_entry.get("id") or ""
    if osv_id:
        return osv_id
    return "—"


def infer_severity(osv_entry: dict | str) -> str:
    if isinstance(osv_entry, str):
        return "Medium"
    db_specific = osv_entry.get("database_specific") or {}
    if isinstance(db_specific, dict):
        for key in ("severity", "importance"):
            if db_specific.get(key):
                return normalize_severity(str(db_specific[key]))
    return "Medium"


def module_from_trace(trace: list) -> str:
    if not trace:
        return "—"
    first = trace[0]
    if not isinstance(first, dict):
        return "—"
    for key in ("module", "Module", "package", "Package"):
        if first.get(key):
            return str(first[key])
    return "—"


def parse_govulncheck_lines(raw: str, display_name: str) -> list[dict]:
    rows: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    osv_catalog: dict[str, dict] = {}

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        osv_payload = event.get("osv")
        if isinstance(osv_payload, dict) and osv_payload.get("id"):
            osv_catalog[str(osv_payload["id"])] = osv_payload
            continue

        finding = event.get("finding")
        if not isinstance(finding, dict):
            if isinstance(event.get("OSV"), dict):
                finding = event
            elif event.get("osv") and isinstance(event.get("fixed_version"), str):
                finding = event
            else:
                continue

        osv_ref = finding.get("osv") or finding.get("OSV") or ""
        osv_entry: dict | str
        if isinstance(osv_ref, dict):
            osv_entry = osv_ref
            osv_id = str(osv_entry.get("id") or "unknown")
        else:
            osv_id = str(osv_ref or "unknown")
            osv_entry = osv_catalog.get(osv_id, osv_id)

        fixed_version = (
            finding.get("fixed_version")
            or finding.get("FixedVersion")
            or finding.get("fixedVersion")
            or "—"
        )
        trace = finding.get("trace") or finding.get("Trace") or []
        symbol = finding.get("symbol") or finding.get("Symbol") or ""
        module = module_from_trace(trace if isinstance(trace, list) else [])
        if module == "—" and symbol:
            module = symbol.split(".")[0] if "." in symbol else symbol

        key = (osv_id, module, str(fixed_version))
        if key in seen:
            continue
        seen.add(key)

        if isinstance(osv_entry, dict):
            summary = osv_entry.get("summary") or osv_entry.get("details") or f"Vulnerability {osv_id}"
        else:
            summary = f"Vulnerability {osv_id}"

        rows.append(
            {
                "package": module,
                "current_ver": "—",
                "fix_ver": fixed_version if fixed_version else "—",
                "severity": infer_severity(osv_entry),
                "cve": extract_cve(osv_entry),
                "vulnerability": str(summary)[:500],
                "action": (
                    f"Upgrade module to {fixed_version}"
                    if fixed_version and fixed_version != "—"
                    else f"Review {osv_id} and update affected Go dependencies"
                ),
                "repository": display_name,
            }
        )

    severity_order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3, "Info": 4, "Unknown": 5}
    rows.sort(key=lambda r: (severity_order.get(r["severity"], 9), r["package"].lower()))
    for idx, row in enumerate(rows, start=1):
        row["id"] = f"SC-{idx:03d}"
    return rows


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: generate_govulncheck_sca_report.py <govulncheck-report.jsonl> "
            "[output-dir] [display-name] [tool-name] [target-url] [govulncheck-version]"
        )
        return 1

    audit_path = Path(sys.argv[1]).resolve()
    out_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else audit_path.parent
    display_name = sys.argv[3] if len(sys.argv) > 3 else out_dir.name
    tool_name = sys.argv[4] if len(sys.argv) > 4 else "govulncheck"
    target_url = sys.argv[5] if len(sys.argv) > 5 else ""
    scanner_version = sys.argv[6] if len(sys.argv) > 6 else "unknown"

    raw = audit_path.read_text(encoding="utf-8")
    rows = parse_govulncheck_lines(raw, display_name)

    html_path, json_path = write_report_bundle(
        out_dir,
        "govulncheck",
        rows,
        display_name,
        tool_name,
        target_url,
        scanner_version,
        {"govulncheckVersion": scanner_version, "raw": raw},
        version_label="govulncheck",
    )

    print(f"Vulnerabilities: {len(rows)}")
    print(f"SCA summary HTML: {html_path}")
    print(f"JSON output:       {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
