#!/usr/bin/env python3
"""encode_adapter_config.py — base64-encode a JSON file for ``adapterConfig``.

The SGNL SoR template requires the ``adapterConfig`` field to be a base64
encoded JSON string. This helper:

1. Loads the input as JSON (validating it is a JSON object).
2. Re-serializes it with stable, compact formatting.
3. Emits the standard base64 encoding (no line wrapping) to stdout.

For an empty config the output is ``e30=`` (i.e. base64("{}")).

Stdlib only.

Usage:
    python encode_adapter_config.py [<config.json>]

If <config.json> is omitted or "-", reads JSON from stdin.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path


def encode(config: dict) -> str:
    payload = json.dumps(config, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.b64encode(payload).decode("ascii")


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        sys.stderr.write("usage: encode_adapter_config.py [<config.json>]\n")
        return 2

    if not argv or argv[0] == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(argv[0]).read_text(encoding="utf-8")

    raw = raw.strip() or "{}"

    try:
        config = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"encode_adapter_config: invalid JSON: {exc}\n")
        return 1

    if not isinstance(config, dict):
        sys.stderr.write("encode_adapter_config: top-level value must be a JSON object\n")
        return 1

    sys.stdout.write(encode(config))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
