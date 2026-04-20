#!/usr/bin/env python3
"""validate_sor_yaml.py — structural checks for SGNL SoR YAML templates.

Performs targeted, deterministic checks against the SoR template structure
documented at https://help.sgnl.ai/articles/systems-of-record/templates/.

Errors (non-zero exit):
- Required top-level fields missing (varies by ``deliveryMethod``).
- ``type`` does not match ``^[A-Za-z][A-Za-z0-9]*-\\d+\\.\\d+\\.\\d+$``.
- ``adapterConfig`` is not valid base64.
- An entity does not have exactly one ``uniqueId: true`` attribute.
- A ``uniqueId: true`` attribute is missing ``indexed: true``.
- A relationship's ``fromAttribute`` / ``toAttribute`` does not resolve to a
  defined ``<entityExternalId>.<attributeExternalId>`` pair.
- A path relationship references an unknown entity-relationship key.

Warnings (still zero exit):
- Recommended fields missing (description, icon).
- Entity ``displayName`` not set.

Stdlib only. Includes a minimal indent-based YAML parser sufficient for
the SoR template subset (scalars, nested dicts, lists of dicts/scalars).

Usage:
    python validate_sor_yaml.py <sor.yaml>
"""

from __future__ import annotations

import argparse
import base64
import re
import sys
from pathlib import Path
from typing import Any

POLLING_REQUIRED = (
    "displayName",
    "address",
    "defaultSyncFrequency",
    "defaultSyncMinInterval",
    "defaultApiCallFrequency",
    "defaultApiCallMinInterval",
    "type",
    "adapterConfig",
    "auth",
    "entities",
)
SCIM_REQUIRED = (
    "displayName",
    "address",
    "type",
    "auth",
    "entities",
)
EVENT_PUSH_REQUIRED = (
    "displayName",
    "type",
    "deliveryMethod",
    "pushType",
    "pushEventsPath",
    "entities",
)
ENTITY_PUSH_REQUIRED = (
    "displayName",
    "address",
    "type",
    "deliveryMethod",
    "pushType",
    "auth",
    "entities",
)

TYPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.]*-\d+\.\d+\.\d+$")
FREQ_VALUES = {
    "SECONDLY",
    "MINUTELY",
    "HOURLY",
    "DAILY",
    "WEEKLY",
    "MONTHLY",
    "YEARLY",
}
ATTR_TYPES = {"Bool", "DateTime", "Double", "Duration", "Int64", "String"}


# ---------------------------------------------------------------------------
# Minimal YAML parser
# ---------------------------------------------------------------------------


class YamlError(ValueError):
    pass


def _parse_scalar(raw: str) -> Any:
    text = raw.strip()
    if text == "":
        return None
    if text == "~" or text.lower() == "null":
        return None
    if text.lower() == "true":
        return True
    if text.lower() == "false":
        return False
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    try:
        if "." in text or "e" in text or "E" in text:
            return float(text)
        return int(text)
    except ValueError:
        return text


def _strip_comment(line: str) -> str:
    in_single = False
    in_double = False
    for index, char in enumerate(line):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            return line[:index]
    return line


def _tokenize(text: str) -> list[tuple[int, str, int]]:
    """Yield (indent, content, lineno) for non-blank, non-comment lines."""

    out: list[tuple[int, str, int]] = []
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = _strip_comment(raw_line).rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        out.append((indent, line[indent:], index))
    return out


def parse_yaml(text: str) -> Any:
    """Parse the YAML subset used by SGNL SoR templates.

    Supports:
    - Mappings with scalar / mapping / sequence values.
    - Sequences whose items are scalars or mappings (``- key: val``).
    - Quoted and bare scalars, ints, floats, bools, null.
    - Comments and blank lines.

    Does NOT support: anchors/aliases, multi-line strings (|, >), flow
    syntax {a: b, c: d}, complex keys, or merge keys. The SoR templates
    do not use any of those.
    """

    tokens = _tokenize(text)
    pos = 0

    def parse_block(min_indent: int) -> tuple[Any, int]:
        nonlocal pos
        if pos >= len(tokens):
            return None, min_indent
        indent, content, _ = tokens[pos]
        if indent < min_indent:
            return None, min_indent
        if content.startswith("- "):
            return parse_sequence(indent), indent
        return parse_mapping(indent), indent

    def parse_mapping(indent: int) -> dict:
        nonlocal pos
        result: dict[str, Any] = {}
        while pos < len(tokens):
            line_indent, content, lineno = tokens[pos]
            if line_indent < indent:
                break
            if line_indent > indent:
                raise YamlError(f"line {lineno}: unexpected indent")
            if ":" not in content:
                raise YamlError(f"line {lineno}: expected mapping key")
            key, _, value = content.partition(":")
            key = key.strip()
            value_str = value.strip()
            pos += 1
            if value_str in {">", "|", ">-", "|-", ">+", "|+"}:
                result[key] = _consume_block_scalar(value_str, indent)
            elif value_str == "":
                if pos < len(tokens) and tokens[pos][0] > indent:
                    nested, _ = parse_block(tokens[pos][0])
                    result[key] = nested
                else:
                    result[key] = None
            else:
                result[key] = _parse_scalar(value_str)
        return result

    def _consume_block_scalar(marker: str, parent_indent: int) -> str:
        nonlocal pos
        style = marker[0]
        lines: list[str] = []
        block_indent: int | None = None
        while pos < len(tokens):
            line_indent, content, _ = tokens[pos]
            if line_indent <= parent_indent:
                break
            if block_indent is None:
                block_indent = line_indent
            if line_indent < block_indent:
                break
            lines.append(" " * (line_indent - (block_indent or 0)) + content)
            pos += 1
        if style == "|":
            return "\n".join(lines)
        return " ".join(line.strip() for line in lines)

    def parse_sequence(indent: int) -> list:
        nonlocal pos
        items: list[Any] = []
        while pos < len(tokens):
            line_indent, content, lineno = tokens[pos]
            if line_indent < indent:
                break
            if line_indent > indent:
                raise YamlError(f"line {lineno}: unexpected indent in sequence")
            if not content.startswith("- "):
                break
            inner = content[2:]
            inner_indent = indent + 2
            pos += 1
            if ":" in inner and not inner.startswith('"') and not inner.startswith("'"):
                key, _, value_part = inner.partition(":")
                key = key.strip()
                value_str = value_part.strip()
                item: dict[str, Any] = {}
                if value_str == "":
                    if pos < len(tokens) and tokens[pos][0] > inner_indent:
                        nested, _ = parse_block(tokens[pos][0])
                        item[key] = nested
                    else:
                        item[key] = None
                else:
                    item[key] = _parse_scalar(value_str)
                while (
                    pos < len(tokens)
                    and tokens[pos][0] == inner_indent
                    and not tokens[pos][1].startswith("- ")
                ):
                    sub_content = tokens[pos][1]
                    if ":" not in sub_content:
                        raise YamlError(
                            f"line {tokens[pos][2]}: expected mapping in sequence item"
                        )
                    sub_key, _, sub_value = sub_content.partition(":")
                    sub_key = sub_key.strip()
                    sub_value_str = sub_value.strip()
                    pos += 1
                    if sub_value_str == "":
                        if pos < len(tokens) and tokens[pos][0] > inner_indent:
                            nested, _ = parse_block(tokens[pos][0])
                            item[sub_key] = nested
                        else:
                            item[sub_key] = None
                    else:
                        item[sub_key] = _parse_scalar(sub_value_str)
                items.append(item)
            else:
                items.append(_parse_scalar(inner))
        return items

    if not tokens:
        return {}
    if tokens[0][1].startswith("- "):
        result = parse_sequence(tokens[0][0])
    else:
        result = parse_mapping(tokens[0][0])
    if pos != len(tokens):
        leftover = tokens[pos]
        raise YamlError(f"line {leftover[2]}: parser did not consume all input")
    return result


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------


def required_fields(template: dict) -> tuple[str, ...]:
    delivery = (template.get("deliveryMethod") or "").strip().lower()
    if delivery == "eventpush":
        return EVENT_PUSH_REQUIRED
    if delivery == "entitypush":
        return ENTITY_PUSH_REQUIRED
    if delivery == "scim" or (template.get("type") or "").lower().startswith("scim"):
        return SCIM_REQUIRED
    return POLLING_REQUIRED


def collect_attributes(entity: dict) -> list[dict]:
    attrs = entity.get("attributes") or []
    if not isinstance(attrs, list):
        return []
    return [a for a in attrs if isinstance(a, dict)]


def validate(template: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(template, dict):
        return ["top-level YAML must be a mapping"], warnings

    required = required_fields(template)
    for field in required:
        if field not in template or template[field] in (None, ""):
            errors.append(f"missing required top-level field: {field}")

    sor_type = template.get("type")
    if isinstance(sor_type, str) and sor_type and not TYPE_RE.match(sor_type):
        errors.append(
            f"type {sor_type!r} must match <Name>-MAJOR.MINOR.PATCH (e.g. Foo-1.0.0)"
        )

    adapter_config = template.get("adapterConfig")
    if adapter_config is not None:
        if not isinstance(adapter_config, str):
            errors.append("adapterConfig must be a base64-encoded JSON string")
        else:
            try:
                base64.b64decode(adapter_config, validate=True)
            except (ValueError, base64.binascii.Error):
                errors.append("adapterConfig is not valid base64")

    for field in ("defaultSyncFrequency", "defaultApiCallFrequency"):
        value = template.get(field)
        if isinstance(value, str) and value not in FREQ_VALUES:
            errors.append(
                f"{field}={value!r} must be one of {sorted(FREQ_VALUES)}"
            )

    if "icon" not in template:
        warnings.append("icon not set; SGNL Console will show a generic icon")
    if "description" not in template:
        warnings.append("description not set")

    entities = template.get("entities") or {}
    if not isinstance(entities, dict):
        errors.append("entities must be a mapping of <Name>: <entitySpec>")
        entities = {}

    attribute_index: dict[tuple[str, str], dict] = {}
    entity_external_ids: set[str] = set()

    for entity_key, entity in entities.items():
        if not isinstance(entity, dict):
            errors.append(f"entities.{entity_key} must be a mapping")
            continue
        external_id = entity.get("externalId") or entity_key
        entity_external_ids.add(external_id)

        if not entity.get("displayName"):
            warnings.append(f"entities.{entity_key}.displayName not set")
        if not entity.get("externalId"):
            warnings.append(
                f"entities.{entity_key}.externalId not set; key {entity_key!r} used as fallback"
            )

        attrs = collect_attributes(entity)
        unique_count = 0
        for attr in attrs:
            name = attr.get("externalId") or attr.get("name")
            if not name:
                errors.append(
                    f"entities.{entity_key}: attribute missing both name and externalId"
                )
                continue
            attribute_index[(external_id, name)] = attr
            attr_type = attr.get("type")
            if attr_type and attr_type not in ATTR_TYPES:
                errors.append(
                    f"entities.{entity_key}.{name}.type={attr_type!r} not in {sorted(ATTR_TYPES)}"
                )
            if attr.get("uniqueId") is True:
                unique_count += 1
                if attr.get("indexed") is not True:
                    errors.append(
                        f"entities.{entity_key}.{name}: uniqueId=true requires indexed=true"
                    )
        if attrs and unique_count != 1:
            errors.append(
                f"entities.{entity_key} must have exactly one uniqueId: true attribute"
                f" (found {unique_count})"
            )

    relationships = template.get("relationships")
    entity_relationship_keys: set[str] = set()
    if relationships is None:
        pass
    elif isinstance(relationships, dict):
        for rel_key, rel in relationships.items():
            entity_relationship_keys.add(rel_key)
            _check_relationship(rel_key, rel, attribute_index, errors)
    elif isinstance(relationships, list):
        for index, rel in enumerate(relationships):
            label = f"relationships[{index}]"
            if isinstance(rel, dict) and rel.get("name"):
                entity_relationship_keys.add(str(rel["name"]))
            _check_relationship(label, rel, attribute_index, errors)
    else:
        errors.append("relationships must be a list or mapping")

    if isinstance(relationships, dict):
        for rel_key, rel in relationships.items():
            if not isinstance(rel, dict):
                continue
            path = rel.get("path")
            if isinstance(path, list):
                for index, step in enumerate(path):
                    if not isinstance(step, dict):
                        continue
                    target = step.get("relationship")
                    if target and target not in entity_relationship_keys:
                        errors.append(
                            f"relationships.{rel_key}.path[{index}].relationship={target!r}"
                            f" does not match any entity relationship key"
                        )
                    direction = step.get("direction")
                    if direction and direction.upper() not in {"FORWARD", "BACKWARD"}:
                        errors.append(
                            f"relationships.{rel_key}.path[{index}].direction={direction!r}"
                            " must be FORWARD or BACKWARD"
                        )

    return errors, warnings


def _check_relationship(
    label: str,
    rel: Any,
    attribute_index: dict[tuple[str, str], dict],
    errors: list[str],
) -> None:
    if not isinstance(rel, dict):
        errors.append(f"{label} must be a mapping")
        return
    if "path" in rel:
        if not isinstance(rel.get("path"), list) or not rel["path"]:
            errors.append(f"{label}: path relationship requires a non-empty list")
        return
    if "childEntity" in rel:
        if not isinstance(rel.get("childEntity"), str) or not rel["childEntity"].strip():
            errors.append(f"{label}: childEntity must be a non-empty string")
        return
    for end in ("fromAttribute", "toAttribute"):
        ref = rel.get(end)
        if not ref:
            errors.append(f"{label}: missing {end}")
            continue
        if "." not in ref:
            errors.append(f"{label}.{end}={ref!r} must be <entity>.<attribute>")
            continue
        entity_id, _, attr_id = ref.partition(".")
        if (entity_id, attr_id) not in attribute_index:
            errors.append(
                f"{label}.{end}={ref!r} does not resolve to a defined entity/attribute"
            )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--quiet", action="store_true", help="suppress warnings on stdout")
    args = parser.parse_args(argv)

    text = args.path.read_text(encoding="utf-8")
    try:
        template = parse_yaml(text)
    except YamlError as exc:
        sys.stderr.write(f"YAML parse error in {args.path}: {exc}\n")
        return 2

    errors, warnings = validate(template)

    for warning in warnings:
        if not args.quiet:
            sys.stdout.write(f"WARN: {warning}\n")
    for error in errors:
        sys.stderr.write(f"ERROR: {error}\n")

    if errors:
        return 1
    sys.stdout.write(f"OK: {args.path} (warnings: {len(warnings)})\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
