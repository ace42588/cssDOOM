# PingAccess Admin API reference

The skill talks to the PingAccess **Admin API** at
`${PA_ADMIN_HOST}/pa-admin-api/v3`. Full reference:
<https://docs.pingidentity.com/r/en-us/pingaccess/pingaccess_administrator_api>.

## Auth

Basic auth with `PA_ADMIN_USER` / `PA_ADMIN_PASS`. Every request must
also send `X-XSRF-Header: PingAccess` (or any non-empty value) — the
admin API uses this as a CSRF guard.

```bash
curl -ksu "$PA_ADMIN_USER:$PA_ADMIN_PASS" \
     -H 'X-XSRF-Header: PingAccess' \
     -H 'Content-Type: application/json' \
     "${PA_ADMIN_HOST}/pa-admin-api/v3/version"
```

The `-k` (insecure TLS) flag is acceptable for self-signed admin
certificates; production deploys should pin the admin CA via
`--cacert`.

## Resource model the skill creates

```
Virtual Host  ── declares the public hostname:port the Engine listens on
   |
Application   ── binds a Virtual Host to one or more Resources / Sites
   |
Site          ── the backend (host, port, secure?) the Engine proxies to
```

The skill creates **one Virtual Host**, **one Site per backend port**,
and **one Application** that maps the Virtual Host to the primary Site.
Identity Mapping, Web Session, and Policies are deliberately not
touched — see the manual handoff in [SKILL.md](../SKILL.md) Phase G
Step 3.

## Endpoints

### Virtual Host

`POST /pa-admin-api/v3/virtualhosts`

Minimal body:

```json
{
  "host": "doom.example.com",
  "port": 443,
  "agentResourceCacheTTL": 900,
  "keyPairId": 0
}
```

`keyPairId` of `0` means "use the listener's default Key Pair". To pin
a specific pair, query `GET /keyPairs` and set its numeric ID.

`GET /virtualhosts` returns all existing — used to detect collisions
before creating.

### Site

`POST /pa-admin-api/v3/sites`

```json
{
  "name": "cssdoom-web",
  "targets": ["10.0.0.42:8080"],
  "secure": false,
  "trustedCertificateGroupId": 0,
  "useTargetHostHeader": true,
  "skipHostnameVerification": true,
  "useProxy": false,
  "sendPaCookie": true,
  "expectedHostname": null
}
```

`targets` is an array — load-balance by listing multiple `host:port`
entries. `secure: true` forces HTTPS to the backend (rare for an
internal Docker host).

### Application

`POST /pa-admin-api/v3/applications`

```json
{
  "name": "cssdoom",
  "applicationType": "Web",
  "contextRoot": "/",
  "caseSensitivePath": false,
  "defaultAuthType": "Web",
  "destination": "Site",
  "siteId": 17,
  "virtualHostIds": [4],
  "enabled": true,
  "agentId": 0,
  "webSessionId": 0,
  "identityMappingIds": { "Web": 0, "API": 0 },
  "policy": { "Web": [], "API": [] },
  "spaSupportEnabled": false
}
```

Notes:
- `siteId` and `virtualHostIds` come from the responses of the previous
  two POSTs.
- `webSessionId: 0` / `identityMappingIds.Web: 0` / `policy.Web: []`
  is the "unprotected" state. The Application will be created and the
  Engine will proxy traffic, but no SSO will fire until you attach a
  Web Session in the UI.
- `applicationType: "Web"` is correct for a browser-facing app
  (including ones with WebSocket upgrades). For backend APIs called by
  agents/services, use `"API"` and add `defaultAuthType: "API"`.

## Collision handling

For every resource the skill checks `GET /<collection>?name=<name>`
first. PA returns paged `items`. If the named resource exists, ask the
user via `AskQuestion`:

- **Reuse existing**: capture the existing ID and skip the POST.
- **Update in place**: `PUT /<collection>/<id>` with the rendered body.
- **Abort**: stop Phase G; nothing else has been mutated.

## Reload (cluster mode only)

If the deployment is clustered, configuration changes propagate when
you POST to:

```
POST /pa-admin-api/v3/clusterConfig/reload
```

In single-node mode this happens automatically.

## Useful read-only calls for debugging

```bash
GET /version                              # smoke test auth
GET /virtualhosts                         # find a vhost ID
GET /sites?name=cssdoom-web               # find a site by name
GET /applications/<id>/effectivePolicy    # what policies actually apply
GET /engine/listeners                     # confirm the public port + key pair
```
