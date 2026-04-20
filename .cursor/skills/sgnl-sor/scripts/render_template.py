#!/usr/bin/env python3
"""render_template.py — minimal {{KEY}} substitution for skill templates.

Reads a template file and a JSON file of substitutions. Writes the rendered
output to stdout (or to --out).

Substitution rules:
- ``{{KEY}}`` is replaced with the JSON value at top-level key ``KEY``.
- Values may be strings, numbers, or booleans (rendered as their str()).
- Unknown ``{{KEY}}`` placeholders cause a non-zero exit unless --allow-missing.
- No conditionals, no loops; loop-shaped sections (entities, attributes) are
  pre-rendered into a single string by the caller before invoking this.

Stdlib only.

Usage:
    python render_template.py <template> <vars.json> [--out <path>] [--allow-missing]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PLACEHOLDER = re.compile(r"\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}")


def render(template: str, variables: dict, allow_missing: bool) -> str:
    missing: list[str] = []

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in variables:
            missing.append(key)
            return match.group(0) if allow_missing else ""
        value = variables[key]
        if isinstance(value, bool):
            return "true" if value else "false"
        return str(value)

    rendered = PLACEHOLDER.sub(repl, template)
    if missing and not allow_missing:
        raise SystemExit(
            "render_template: missing variables: " + ", ".join(sorted(set(missing)))
        )
    return rendered


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("variables", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--allow-missing", action="store_true")
    args = parser.parse_args(argv)

    template_text = args.template.read_text(encoding="utf-8")
    variables = json.loads(args.variables.read_text(encoding="utf-8"))
    if not isinstance(variables, dict):
        raise SystemExit("render_template: variables JSON must be an object")

    rendered = render(template_text, variables, args.allow_missing)

    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
