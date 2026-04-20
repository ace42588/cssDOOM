#!/usr/bin/env python3
"""detect_app.py - inspect the current repo for a Dockerized Node app.

Emits a JSON report on stdout used by the deploy-node-proxmox-pingaccess
skill. Stdlib only; YAML is parsed with a tiny indent-aware fallback so
PyYAML is not required.

The report is advisory; the agent confirms with the user before using
its values to render anything.

Usage:
    python3 detect_app.py [--root <dir>]

Top-level keys in the JSON report:
- ``root``           absolute repo path
- ``dockerfile``     relative path or ``null``
- ``composeFile``    relative path or ``null``
- ``services``       [{name, target, ports:[host:container], image}]
- ``envExample``     relative path or ``null``
- ``nodeVersion``    string from package.json#engines.node, or ``null``
- ``healthchecks``   [{service, port, path}] inferred from compose +
                     ``HEALTHCHECK`` directives in the Dockerfile
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

COMPOSE_NAMES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
HEALTHCHECK_RE = re.compile(
    r"HEALTHCHECK[^\n]*\n[^\n]*?(?:wget|curl)[^\n]*?http://[^/\s:]+(?::(\d+))?(/[\w\-./]*)",
    re.IGNORECASE,
)
SIMPLE_PORT_RE = re.compile(r"^\s*-\s*[\"']?(\d+)(?:/[a-z]+)?[\"']?\s*$")
# Replace `${VAR:-NNN}` with the literal NNN so `:` becomes a clean
# separator between bind / host / container. Anything still wrapped in a
# bare `${VAR}` (no default) is opaque and the segment is dropped.
DEFAULTED_VAR_RE = re.compile(r"\$\{[^:}]+:-([^}]+)\}")
PLAIN_VAR_RE = re.compile(r"\$\{[^}]+\}")


def parse_compose_port_line(line: str) -> dict | None:
    """Compose ports list entry -> {host, container} or None.

    Handles:
      - 8080
      - 8080:80
      - "127.0.0.1:8080:80"
      - "${WEB_BIND:-127.0.0.1}:${WEB_PORT:-8080}:80"
      - "8080:80/tcp"
    """
    m = SIMPLE_PORT_RE.match(line)
    if m:
        p = int(m.group(1))
        return {"host": p, "container": p}

    body = line.strip().lstrip("-").strip().strip("'\"")
    body = body.split("#", 1)[0].rstrip().strip("'\"")
    if not body or ":" not in body:
        return None

    expanded = DEFAULTED_VAR_RE.sub(lambda m: m.group(1), body)
    expanded = PLAIN_VAR_RE.sub("", expanded)
    expanded = expanded.split("/", 1)[0]  # strip /tcp etc.

    parts = [p for p in expanded.split(":") if p.strip()]
    if not parts:
        return None
    try:
        container = int(parts[-1])
    except ValueError:
        return None
    host = container
    if len(parts) >= 2:
        try:
            host = int(parts[-2])
        except ValueError:
            host = container
    return {"host": host, "container": container}


def find_first(root: Path, names) -> Path | None:
    for name in names:
        path = root / name
        if path.is_file():
            return path
    return None


def parse_compose(path: Path) -> list[dict]:
    """Return [{name, target, ports:[{host,container}], image}] from compose.

    Indent-based parser sufficient for the well-formed compose this skill
    targets. Unknown shapes degrade to empty fields rather than raising.
    """
    services: list[dict] = []
    current: dict | None = None
    in_services = False
    in_build = False
    in_ports = False
    services_indent = 0
    service_indent = 0

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())

        if not in_services:
            if line.lstrip().startswith("services:"):
                in_services = True
                services_indent = indent
            continue

        if indent <= services_indent and line.lstrip() != "services:":
            in_services = False
            in_build = False
            in_ports = False
            current = None
            continue

        # New service header: e.g. "  web:" two spaces deeper than services:
        stripped = line.lstrip()
        if (
            indent == services_indent + 2
            and stripped.endswith(":")
            and not stripped.startswith("-")
        ):
            current = {"name": stripped[:-1], "target": None, "ports": [], "image": None}
            services.append(current)
            service_indent = indent
            in_build = False
            in_ports = False
            continue

        if current is None:
            continue

        if indent <= service_indent:
            in_build = False
            in_ports = False

        if stripped.startswith("image:"):
            current["image"] = stripped.split(":", 1)[1].strip().strip("'\"")
            in_build = False
            in_ports = False
        elif stripped.startswith("build:"):
            tail = stripped[len("build:"):].strip()
            if tail and tail != "|":
                current["target"] = None  # short form, no target known
                in_build = False
            else:
                in_build = True
                in_ports = False
        elif stripped.startswith("target:") and in_build:
            current["target"] = stripped.split(":", 1)[1].strip().strip("'\"")
        elif stripped.startswith("ports:"):
            in_ports = True
            in_build = False
        elif in_ports:
            entry = parse_compose_port_line(line)
            if entry is not None:
                current["ports"].append(entry)

    return services


def parse_dockerfile_healthchecks(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    out: list[dict] = []
    for match in HEALTHCHECK_RE.finditer(text):
        port = int(match.group(1)) if match.group(1) else 80
        out.append({"port": port, "path": match.group(2)})
    return out


def parse_node_version(package_json: Path) -> str | None:
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    engines = data.get("engines") if isinstance(data, dict) else None
    if isinstance(engines, dict):
        node = engines.get("node")
        if isinstance(node, str):
            return node
    return None


def attach_healthchecks(services: list[dict], dockerfile_hcs: list[dict]) -> list[dict]:
    """Best-effort: pair each Dockerfile HEALTHCHECK with the service whose
    container port matches. The Dockerfile in this repo declares two
    HEALTHCHECKs (web on :80, server on :8787), so this works without
    needing to track which build target each appeared in."""
    out: list[dict] = []
    for svc in services:
        container_ports = {p["container"] for p in svc["ports"]}
        for hc in dockerfile_hcs:
            if hc["port"] in container_ports:
                out.append({"service": svc["name"], "port": hc["port"], "path": hc["path"]})
                break
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)

    root = args.root.resolve()
    dockerfile = root / "Dockerfile"
    dockerfile_rel = dockerfile.relative_to(root).as_posix() if dockerfile.is_file() else None

    compose = find_first(root, COMPOSE_NAMES)
    compose_rel = compose.relative_to(root).as_posix() if compose else None
    services = parse_compose(compose) if compose else []

    dockerfile_hcs = parse_dockerfile_healthchecks(dockerfile) if dockerfile.is_file() else []
    healthchecks = attach_healthchecks(services, dockerfile_hcs)

    env_example = root / ".env.example"
    env_example_rel = env_example.relative_to(root).as_posix() if env_example.is_file() else None

    package_json = root / "package.json"
    node_version = parse_node_version(package_json) if package_json.is_file() else None

    report = {
        "root": str(root),
        "dockerfile": dockerfile_rel,
        "composeFile": compose_rel,
        "services": services,
        "envExample": env_example_rel,
        "nodeVersion": node_version,
        "healthchecks": healthchecks,
    }
    json.dump(report, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
