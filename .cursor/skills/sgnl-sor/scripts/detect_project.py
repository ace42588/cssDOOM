#!/usr/bin/env python3
"""detect_project.py — heuristic scan of the current repo to seed a SoR.

Walks the working directory (skipping common build/dependency folders) and
produces a JSON report on stdout with three top-level keys:

- ``dominantLanguage``: one of ``node``, ``python``, ``go``, ``java``,
  ``rust``, ``ruby``, ``csharp``, or ``unknown``.
- ``existingSorYamls``: list of {path, displayName, type} for files that
  look like SGNL SoR templates (top-level ``displayName`` + ``entities``
  or ``adapterConfig``).
- ``candidateEntities``: list of {source, name, hint} extracted from
  JSON Schema files, OpenAPI specs, and obvious model/schema source files.
  Purely advisory; the user / agent confirms before generation.

Stdlib only. Designed to fail gracefully on unreadable files.

Usage:
    python detect_project.py [--root <dir>] [--max-files N]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

LANG_BY_EXT = {
    ".js": "node",
    ".mjs": "node",
    ".cjs": "node",
    ".jsx": "node",
    ".ts": "node",
    ".tsx": "node",
    ".py": "python",
    ".go": "go",
    ".java": "java",
    ".kt": "java",
    ".rs": "rust",
    ".rb": "ruby",
    ".cs": "csharp",
}

SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
    ".idea",
    ".vscode",
    "sgnl-work",
    ".cursor",
}


def _should_skip(path: Path, root: Path) -> bool:
    parts = path.relative_to(root).parts
    for part in parts:
        if part in SKIP_DIRS:
            return True
        # Ignore virtualenv directories with suffixes, e.g. `.venv-sprites`.
        if part.startswith(".venv"):
            return True
    return False

YAML_LIKELY_DIRS = ("public/sgnl", "sgnl", "config/sgnl")
SCHEMA_DIR_HINTS = ("schemas", "schema", "models", "entities")

DISPLAY_NAME_RE = re.compile(r"^displayName\s*:\s*(.+?)\s*$", re.MULTILINE)
TYPE_RE = re.compile(r"^type\s*:\s*[\"']?([^\"'\s#]+)", re.MULTILINE)
SOR_MARKERS = ("entities:", "adapterConfig:")


def walk(root: Path, max_files: int):
    count = 0
    for path in root.rglob("*"):
        if _should_skip(path, root):
            continue
        if not path.is_file():
            continue
        count += 1
        if count > max_files:
            return
        yield path


def detect_language(files: list[Path]) -> str:
    counts: dict[str, int] = {}
    for path in files:
        lang = LANG_BY_EXT.get(path.suffix.lower())
        if not lang:
            continue
        counts[lang] = counts.get(lang, 0) + 1
    if not counts:
        return "unknown"
    return max(counts.items(), key=lambda kv: kv[1])[0]


def find_sor_yamls(files: list[Path], root: Path) -> list[dict]:
    out: list[dict] = []
    for path in files:
        if path.suffix.lower() not in {".yaml", ".yml"}:
            continue
        rel = path.relative_to(root).as_posix()
        in_sgnl_dir = any(rel.startswith(prefix + "/") for prefix in YAML_LIKELY_DIRS)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "displayName" not in text:
            continue
        if not any(marker in text for marker in SOR_MARKERS) and not in_sgnl_dir:
            continue
        display = DISPLAY_NAME_RE.search(text)
        sor_type = TYPE_RE.search(text)
        out.append(
            {
                "path": rel,
                "displayName": _strip_quotes(display.group(1)) if display else None,
                "type": sor_type.group(1) if sor_type else None,
            }
        )
    return out


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def find_candidate_entities(files: list[Path], root: Path, limit: int) -> list[dict]:
    candidates: list[dict] = []

    for path in files:
        rel = path.relative_to(root).as_posix()
        suffix = path.suffix.lower()

        if suffix == ".json":
            entity = _entity_from_json_schema(path)
            if entity:
                candidates.append({"source": rel, "name": entity, "hint": "json-schema"})
                continue

        if any(hint in rel.lower() for hint in SCHEMA_DIR_HINTS):
            stem = path.stem
            cleaned = re.sub(r"[-_]?(schema|model|entity)$", "", stem, flags=re.IGNORECASE)
            cleaned = re.sub(r"^scim[-_]?", "", cleaned, flags=re.IGNORECASE)
            if cleaned and cleaned.lower() not in {"index", "init"}:
                candidates.append(
                    {"source": rel, "name": cleaned, "hint": f"path:{suffix or 'dir'}"}
                )

        if len(candidates) >= limit:
            break

    seen: set[tuple[str, str]] = set()
    deduped: list[dict] = []
    for cand in candidates:
        key = (cand["name"].lower(), cand["hint"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(cand)
    return deduped


def _entity_from_json_schema(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if "$schema" not in text and '"properties"' not in text and '"schemas"' not in text:
        return None
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    title = data.get("title") or data.get("name") or data.get("id")
    if isinstance(title, str) and title.strip():
        return title.strip()
    if "properties" in data and isinstance(data["properties"], dict):
        return path.stem
    return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--max-files", type=int, default=20000)
    parser.add_argument("--max-candidates", type=int, default=64)
    args = parser.parse_args(argv)

    root = args.root.resolve()
    files = list(walk(root, args.max_files))
    report = {
        "root": str(root),
        "fileCount": len(files),
        "dominantLanguage": detect_language(files),
        "existingSorYamls": find_sor_yamls(files, root),
        "candidateEntities": find_candidate_entities(files, root, args.max_candidates),
    }
    json.dump(report, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
