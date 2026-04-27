# AI Limit Timer in Docker (M1)

The repository ships a small **OCI** image for **running** the program on a Linux system (or a Linux engine such as Colima, Docker Desktop, or Podman). The image is **in-repo** only (M1); **no** registry is published in this milestone (see the M2 milestone for GHCR, etc.).

## What the image is for

- Run **`status`** (default command) or **`run`** in a one-shot or scripted way, with a mounted config and state directory.
- **It does not install `codex` or `claude` for you.** Those CLIs are expected to exist in the same filesystem namespace as the process (e.g. bind-mounted from the host) or a path you set in the JSON config. Without them, only parser-adjacent logic that does not need those binaries will behave like on the host.

**Scheduling (systemd / launchd):** Installing user timers is meant for a **host** with a logind / GUI session, not a minimal container without `systemd` user management and D-Bus. For a container workflow, use **the host** (cron, systemd on the host, Kubernetes CronJob) to `docker run ... run` on an interval, or use `run` manually.

## Build

From the repository root (requires Docker BuildKit — default in recent Docker):

```bash
docker build -t ai-limit-timer:local .
```

## Run: status

Mount your **config** and **var** (state, logs) so the app can read/write. Use a **config path** that exists inside the container. Example layout:

| Host | Container | Mode |
|------|-------------|------|
| `./ai-limit-timer.config.json` | `/data/ai-limit-timer.config.json` | read-only (config) |
| `./var` | `/data/var` | read-write (state) |
| `~/.codex/sessions` | `/data/.codex/sessions` | read-only (Codex logs) if you use Codex |

Your config must point `codex.sessionRoot` and provider `workspaceDir` (and any paths) at locations **inside** the container that you mount, e.g. `"/data/.codex/sessions"`, `"/workspaces/codex"`.

```bash
docker run --rm \
  -v "$PWD/ai-limit-timer.config.json:/data/ai-limit-timer.config.json:ro" \
  -v "$PWD/var:/data/var" \
  -e HOME=/data \
  -e AI_LIMIT_TIMER_CONFIG=/data/ai-limit-timer.config.json \
  ai-limit-timer:local \
  status
```

Using `AI_LIMIT_TIMER_CONFIG` matches how you can run the app without a long `CMD` (same precedence as the CLI: you can still pass `status --config /path/...` if you prefer). `HOME=/data` makes `~/.codex` resolve under `/data` if you use `~` in the config.

## Run: one cycle (`run`)

```bash
docker run --rm \
  -v "$PWD/ai-limit-timer.config.json:/data/ai-limit-timer.config.json:ro" \
  -v "$PWD/var:/data/var" \
  -v "/abs/path/codex/bin:/opt/bin:ro" \
  -e PATH="/opt/bin:/usr/local/bin:/usr/bin:/bin" \
  -e HOME=/data \
  ai-limit-timer:local \
  run --config /data/ai-limit-timer.config.json
```

Point `codex.command` and `claude.command` in JSON at the mounted CLI paths, or add them to `PATH` as above. **Claude** often needs a trusted `workspaceDir` that exists in the mount namespace.

## Avoid spaces in generated paths (Linux + systemd on host)

If you use the **host** to install the systemd units created for Linux, the generated unit files are easiest when **paths contain no spaces**. Prefer short mount paths (e.g. `/data/...`).

## Non-root

The image runs as the **`node`** user (uid **1000** in the base image). Ensure mounted directories are readable/writable by that uid, e.g.:

```bash
chown -R 1000:1000 var
```

## Health check

The image has no `HEALTHCHECK` (optional follow-up for M2+).

## Compose (optional)

You can create a `compose.yaml` that mirrors the `docker run` above (bind mounts, `environment`, `user: "1000:1000"` if you align uid). No compose file is committed in M1 to avoid prescriptive local paths; copy the examples here.

---

**M1 vs M2:** Pushing a tagged image to a registry (e.g. GHCR) and CI publish are **M2** work.
