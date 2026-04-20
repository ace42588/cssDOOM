#!/usr/bin/env python3
"""pa_api.py - minimal PingAccess Admin API client for the deploy skill.

Subcommands:
  apply <draft-dir>     POST pa-virtualhost.json + every pa-site*.json +
                        pa-application.json (in that order). For each
                        resource, look it up by name first; if it exists,
                        prompt on stdin (reuse / update / abort). Captured
                        IDs land in <draft-dir>/../out/pa-resources.json.

Requires env: PA_ADMIN_HOST, PA_ADMIN_USER, PA_ADMIN_PASS.
Optional env: PA_INSECURE_TLS=1 to skip cert verification.

Stdlib only.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-XSRF-Header": "PingAccess",
}


class PaClient:
    def __init__(self, base_url: str, user: str, password: str, insecure: bool):
        self.base_url = base_url.rstrip("/") + "/pa-admin-api/v3"
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        self.auth_header = {"Authorization": f"Basic {token}"}
        self.context = ssl._create_unverified_context() if insecure else None

    def _req(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
        url = self.base_url + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in {**DEFAULT_HEADERS, **self.auth_header}.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, context=self.context, timeout=30) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                payload = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                payload = {"raw": raw.decode("utf-8", errors="replace")}
            return exc.code, payload

    def get_by_name(self, collection: str, name: str) -> dict | None:
        from urllib.parse import quote
        status, body = self._req("GET", f"/{collection}?name={quote(name)}")
        if status != 200 or not isinstance(body, dict):
            return None
        for item in body.get("items", []) or []:
            if item.get("name") == name:
                return item
        return None

    def create(self, collection: str, body: dict) -> dict:
        status, payload = self._req("POST", f"/{collection}", body)
        if status not in (200, 201):
            raise SystemExit(
                f"pa_api: POST /{collection} failed ({status}): {json.dumps(payload, indent=2)}"
            )
        return payload  # type: ignore[return-value]

    def update(self, collection: str, resource_id: int, body: dict) -> dict:
        status, payload = self._req("PUT", f"/{collection}/{resource_id}", body)
        if status not in (200,):
            raise SystemExit(
                f"pa_api: PUT /{collection}/{resource_id} failed ({status}): {json.dumps(payload, indent=2)}"
            )
        return payload  # type: ignore[return-value]


def prompt_collision(name: str, collection: str) -> str:
    sys.stderr.write(
        f"pa_api: {collection} '{name}' already exists.\n"
        "  [r]euse existing / [u]pdate in place / [a]bort: "
    )
    sys.stderr.flush()
    answer = sys.stdin.readline().strip().lower() or "r"
    if answer not in {"r", "u", "a"}:
        return prompt_collision(name, collection)
    if answer == "a":
        raise SystemExit("pa_api: aborted by user")
    return answer


def upsert(client: PaClient, collection: str, body: dict, name_field: str = "name") -> dict:
    name = body[name_field] if name_field == "name" else body.get("host")
    lookup_name = body.get("name") or body.get("host")
    existing = client.get_by_name(collection, lookup_name)
    if existing is None:
        result = client.create(collection, body)
        sys.stderr.write(f"pa_api: created {collection} id={result.get('id')} ({lookup_name})\n")
        return result
    decision = prompt_collision(lookup_name, collection)
    if decision == "r":
        sys.stderr.write(f"pa_api: reusing {collection} id={existing.get('id')} ({lookup_name})\n")
        return existing
    result = client.update(collection, existing["id"], {**body, "id": existing["id"]})
    sys.stderr.write(f"pa_api: updated {collection} id={result.get('id')} ({lookup_name})\n")
    return result


def cmd_apply(draft_dir: Path) -> int:
    out_dir = draft_dir.parent / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    base = os.environ.get("PA_ADMIN_HOST")
    user = os.environ.get("PA_ADMIN_USER")
    password = os.environ.get("PA_ADMIN_PASS")
    if not (base and user and password):
        raise SystemExit("pa_api: PA_ADMIN_HOST, PA_ADMIN_USER, PA_ADMIN_PASS must be set")
    insecure = os.environ.get("PA_INSECURE_TLS", "0") == "1"

    client = PaClient(base, user, password, insecure)

    vhost_path = draft_dir / "pa-virtualhost.json"
    app_path = draft_dir / "pa-application.json"
    site_paths = sorted(draft_dir.glob("pa-site*.json"))
    for required in (vhost_path, app_path):
        if not required.is_file():
            raise SystemExit(f"pa_api: {required} not found in {draft_dir}")
    if not site_paths:
        raise SystemExit(f"pa_api: no pa-site*.json files found in {draft_dir}")

    summary: dict[str, Any] = {"sites": []}

    vhost_body = json.loads(vhost_path.read_text())
    vhost = upsert(client, "virtualhosts", vhost_body, name_field="host")
    summary["virtualHostId"] = vhost["id"]

    primary_site_id: int | None = None
    for site_path in site_paths:
        site_body = json.loads(site_path.read_text())
        site = upsert(client, "sites", site_body)
        summary["sites"].append({"name": site["name"], "id": site["id"]})
        if primary_site_id is None:
            primary_site_id = site["id"]

    app_body = json.loads(app_path.read_text())
    app_body["siteId"] = primary_site_id
    app_body["virtualHostIds"] = [vhost["id"]]
    application = upsert(client, "applications", app_body)
    summary["applicationId"] = application["id"]

    out_file = out_dir / "pa-resources.json"
    out_file.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    sys.stdout.write(f"pa_api: wrote {out_file}\n")
    sys.stdout.write(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    apply_p = sub.add_parser("apply", help="POST rendered PA bodies in order")
    apply_p.add_argument("draft_dir", type=Path)
    args = parser.parse_args(argv)
    if args.cmd == "apply":
        return cmd_apply(args.draft_dir)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
