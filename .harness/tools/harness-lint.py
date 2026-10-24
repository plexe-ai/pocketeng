#!/usr/bin/env python3
"""harness-lint — structural checks for the .harness/ knowledge base.

Checks:
  hard errors (exit 1, or 2 with --strict):
    - every .md file has YAML frontmatter
    - frontmatter has required fields: type, status, last_reviewed, related, tags
    - type is one of {protocol, playbook, reference, learning, harness}
    - status is one of {canonical, draft, deprecated}
    - last_reviewed parses as YYYY-MM-DD

  soft warnings (exit 0 unless --strict):
    - relative links in the body point to a file that exists
    - last_reviewed is within 180 days
    - file exceeds soft size cap for its type and has no `oversized_justification`
    - paths in `related:` exist

Usage:
  python3 .harness/tools/harness-lint.py --root .harness
  python3 .harness/tools/harness-lint.py --root .harness --strict
  python3 .harness/tools/harness-lint.py --root .harness --json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

VALID_TYPES = {"protocol", "playbook", "reference", "learning", "harness"}
VALID_STATUS = {"canonical", "draft", "deprecated"}
REQUIRED_FIELDS = ["type", "status", "last_reviewed", "related", "tags"]

# soft size caps (lines) — matches file-taxonomy guidance. Not hard limits.
SOFT_SIZE_CAP = {
    "protocol": 200,
    "playbook": 300,
    "reference": 400,
    "learning": 200,
    "harness": 200,
}

STALE_AFTER_DAYS = 180

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")

# Files at the top level of .harness/ that are entry-points, not typed knowledge files.
# The top-level README is a routing table; by design it has no frontmatter.
EXEMPT_RELATIVE = {"README.md"}


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Very small YAML subset parser — enough for our frontmatter shape."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw = m.group(1)
    body = text[m.end():]

    data: dict = {}
    current_list: list | None = None
    current_key: str | None = None
    for line in raw.splitlines():
        if not line.strip():
            continue
        if line.startswith("  - "):
            if current_list is None:
                continue
            current_list.append(line[4:].strip().strip("'\""))
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if val == "":
                current_list = []
                data[key] = current_list
                current_key = key
            elif val.startswith("[") and val.endswith("]"):
                inner = val[1:-1].strip()
                data[key] = [s.strip().strip("'\"") for s in inner.split(",") if s.strip()]
                current_list = None
            else:
                data[key] = val.strip("'\"")
                current_list = None
            current_key = key
    return data, body


class Finding:
    def __init__(self, path: Path, severity: str, code: str, message: str):
        self.path = path
        self.severity = severity  # 'error' or 'warn'
        self.code = code
        self.message = message

    def to_dict(self) -> dict:
        return {
            "path": str(self.path),
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        }

    def format(self) -> str:
        colour = "\033[1;31m" if self.severity == "error" else "\033[1;33m"
        tag = "error" if self.severity == "error" else "warn "
        return f"{colour}{tag}\033[0m [{self.code}] {self.path}: {self.message}"


def check_file(path: Path, root: Path, today: dt.date) -> list[Finding]:
    findings: list[Finding] = []
    text = path.read_text(encoding="utf-8")
    data, body = parse_frontmatter(text)

    if not data:
        findings.append(Finding(path, "error", "no-frontmatter", "file has no YAML frontmatter"))
        return findings

    for field in REQUIRED_FIELDS:
        if field not in data:
            findings.append(Finding(path, "error", "missing-field", f"frontmatter missing required field '{field}'"))

    t = data.get("type")
    if t is not None and t not in VALID_TYPES:
        findings.append(Finding(path, "error", "bad-type", f"type '{t}' is not one of {sorted(VALID_TYPES)}"))

    s = data.get("status")
    if s is not None and s not in VALID_STATUS:
        findings.append(Finding(path, "error", "bad-status", f"status '{s}' is not one of {sorted(VALID_STATUS)}"))

    reviewed_str = data.get("last_reviewed")
    reviewed: dt.date | None = None
    if reviewed_str:
        try:
            reviewed = dt.date.fromisoformat(str(reviewed_str))
        except ValueError:
            findings.append(
                Finding(path, "error", "bad-date", f"last_reviewed '{reviewed_str}' is not YYYY-MM-DD")
            )

    # stale?
    if reviewed and (today - reviewed).days > STALE_AFTER_DAYS:
        findings.append(
            Finding(
                path,
                "warn",
                "stale",
                f"last_reviewed {reviewed_str} is {(today - reviewed).days} days old (cap {STALE_AFTER_DAYS})",
            )
        )

    # size
    if t in SOFT_SIZE_CAP:
        n_lines = text.count("\n") + 1
        cap = SOFT_SIZE_CAP[t]
        if n_lines > cap and "oversized_justification" not in data:
            findings.append(
                Finding(
                    path,
                    "warn",
                    "oversized",
                    f"{n_lines} lines > soft cap {cap} for type '{t}', and no oversized_justification in frontmatter",
                )
            )

    # related: paths exist
    related = data.get("related") or []
    if isinstance(related, list):
        for rel in related:
            if not rel:
                continue
            target = (root / rel).resolve()
            if not target.exists():
                findings.append(
                    Finding(path, "warn", "related-missing", f"related path '{rel}' does not exist")
                )

    # body links resolve (only check relative, same-tree markdown/shell links)
    for m in LINK_RE.finditer(body):
        link = m.group(1).strip()
        # strip anchor
        link_no_anchor = link.split("#", 1)[0]
        if not link_no_anchor:
            continue
        if link_no_anchor.startswith(("http://", "https://", "mailto:")):
            continue
        # resolve relative to the file's directory
        target = (path.parent / link_no_anchor).resolve()
        if not target.exists():
            findings.append(
                Finding(path, "warn", "broken-link", f"relative link '{link}' does not resolve")
            )

    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description="Lint the PocketEng .harness/ knowledge base")
    ap.add_argument("--root", default=".harness", help="path to the .harness root (default: .harness)")
    ap.add_argument("--strict", action="store_true", help="treat warnings as errors")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"error: root {root} is not a directory", file=sys.stderr)
        return 2

    today = dt.date.today()
    findings: list[Finding] = []
    md_count = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not name.endswith(".md"):
                continue
            p = Path(dirpath) / name
            rel = p.relative_to(root).as_posix()
            if rel in EXEMPT_RELATIVE:
                continue
            md_count += 1
            findings.extend(check_file(p, root, today))

    errors = [f for f in findings if f.severity == "error"]
    warns = [f for f in findings if f.severity == "warn"]

    if args.json:
        print(json.dumps(
            {
                "root": str(root),
                "files_checked": md_count,
                "errors": [f.to_dict() for f in errors],
                "warnings": [f.to_dict() for f in warns],
            },
            indent=2,
        ))
    else:
        for f in errors + warns:
            print(f.format())
        print()
        print(f"checked {md_count} markdown files under {root}")
        print(f"  {len(errors)} error(s), {len(warns)} warning(s)")

    if errors:
        return 1
    if warns and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
