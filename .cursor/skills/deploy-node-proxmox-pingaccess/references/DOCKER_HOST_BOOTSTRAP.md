# Docker host bootstrap

What `install_docker.sh` does once it's SSHed into the new container or
VM. Both paths converge on the same `docker --version` /
`docker compose version` smoke test.

## LXC (Debian/Ubuntu template)

The container was created with `--features nesting=1,keyctl=1` so the
Docker daemon can start. The bootstrap is the upstream convenience
script — short, well-known, and reproducible:

```bash
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

Verify:

```bash
docker version
docker compose version    # plugin ships in the convenience script
```

If the daemon refuses to start with `failed to register layer:
operation not permitted`, the container is missing `nesting=1` — fix on
the PVE node with:

```bash
pct set <CT_ID> --features nesting=1,keyctl=1
pct reboot <CT_ID>
```

## QEMU VM (cloud-init Debian/Ubuntu)

Cloud-init has already run package updates and laid down the SSH key
during first boot. Bootstrap is identical to the LXC path — kernel
features are not a concern in a real VM:

```bash
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
usermod -aG docker "$VM_CLOUDINIT_USER"   # so the deploy user can run docker
```

If cloud-init flagged `/var/run/reboot-required`, the script reboots
the VM and waits for SSH to come back before exiting.

## Verification step (both paths)

The script exits non-zero if any of these fail:

```bash
docker version --format '{{.Server.Version}}'
docker compose version --short
docker run --rm hello-world | grep -q 'Hello from Docker'
```

The `hello-world` test catches subtle networking / iptables breakage
that `docker version` would silently miss (especially in unprivileged
LXC where `iptables-nft` vs `iptables-legacy` selection matters).

## Ongoing maintenance (out of scope, FYI)

The skill does not configure log rotation, daemon TLS, registry
mirrors, or BuildKit cache cleanup. For long-lived hosts, wire up:

- `/etc/docker/daemon.json` with `log-opts.max-size` / `max-file`.
- A `docker system prune -af` cron, or `docker buildx prune` if you
  build on the host.
- Unattended security updates via `unattended-upgrades`.
