# AI Limit Timer

**Version 0.1.0** — CLI tool (TypeScript → Node.js) that automatically maximizes your token usage on Anthropic’s AI coding tools by reducing lost time to rate-limit reset windows.

**Stack:** TypeScript (strict), Node built-ins only at runtime; macOS (`launchd`) and Linux (`systemd` user units) for scheduling. Source: `src/`, output: `dist/` after `npm run build`.

## Why This Exists

Codex CLI and Claude Code both enforce rolling rate limits: a **5-hour window** and a **weekly window**. When you hit a limit, the timer counts down to a reset — but the fresh allocation only begins when you **actually send your next prompt**. If your 5-hour window resets at 6:00 AM and you don't open your terminal until 9:00 AM, your NEXT rest window won't be until 2pm. With this tool active, your next window will be available at 11am.

This tool fixes that. It:

1. **Reads exact reset timestamps** from Codex session logs and Claude's stream output
2. **Sends a minimal keep-alive prompt** ("Reply with exactly OK.") right after each reset, so your next window starts immediately
3. **Self-schedules** using **macOS `launchd`** or **Linux `systemd` user timers** to wake at the next reset time — no cron jobs, no always-on process

The result: your rate-limit windows overlap seamlessly. You get the maximum available token budget without ever having to think about reset timing.

## How It Works

```
┌──────────────────────────────────────────────────────┐
│                     ai-limit-timer                   │
│                                                      │
│  1. Check current reset times                        │
│     ├─ Codex: read ~/.codex/sessions/**/*.jsonl      │
│     └─ Claude: parse stream-json output              │
│                                                      │
│  2. If any window has reset → send "OK" prompt       │
│     ├─ Codex: codex exec "Reply with exactly OK."    │
│     └─ Claude: claude -p "Reply with exactly OK."    │
│                                                      │
│  3. Compute next reset time (earliest across both)   │
│                                                      │
│  4. Install OS scheduler (launchd plist or systemd)   │
│     → run after reset + 60s                           │
│                                                      │
│  5. OS scheduler wakes the tool → go to step 1       │
└──────────────────────────────────────────────────────┘
```

After a single `npm run run`, the timer runs itself indefinitely (via `launchd` on macOS or `systemd` on Linux). Each cycle updates the next wake time in the job units — no persistent daemon or cron in your project directory.

If your Mac is off or asleep when a scheduled reset passes, the job runs automatically on next login (`RunAtLoad` is enabled). It detects that windows have already reset, sends the keep-alive prompts, and resumes the normal scheduling chain.

### Data Sources

| Provider | Source | Accuracy |
|----------|--------|----------|
| **Codex** | `~/.codex/sessions/**/*.jsonl` — `token_count` payloads with `rate_limits.primary.resets_at` and `rate_limits.secondary.resets_at` | Exact — reads Codex's own persisted timestamps |
| **Claude** | `claude -p --output-format stream-json` — `rate_limit_event` objects with `resetsAt` and `overageResetsAt` | Best-effort — if stream-json doesn't contain rate-limit events, falls back to `now + 5h` for the primary window and preserves the previous weekly reset |

## Requirements

- **macOS** (`scheduler.type: "launchd"`) or **Linux** with **systemd** for user services (`scheduler.type: "systemd"`)
- **Node.js** **20.x or 22.x** (used in CI); **18+** may work but is not CI-guaranteed
- **Codex CLI** (`codex`) — [install guide](https://github.com/openai/codex)
- **Claude Code** (`claude`) — [install guide](https://docs.anthropic.com/en/docs/claude-code)

### Supported platforms (this version)

| | Supported | Not in scope for this release |
|---|-----------------|------------------------|
| **OS** | **macOS** and **Linux** (glibc-based distros with `systemd` for user timers) | **Windows** (native) |
| **Environment** | Bare metal, VM, or container (see [docs/docker.md](docs/docker.md)) | **WSL2** as a *guaranteed* target (may work; not covered by tests) |
| **UI** | CLI only | Web UI or desktop GUI |

Planned follow-ups (milestones in this repo) include a published container image, additional Linux scheduler options, and other delivery work—not part of 0.1.0.

**Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) (dev loop, CI, and tooling).

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/nana-boateng/optimize-ai-limits.git
cd optimize-ai-limits
```

The npm package name is `ai-limit-timer`; the git repository is **`optimize-ai-limits`**.

Copy the example config and edit it:

```bash
cp ai-limit-timer.config.example.json ai-limit-timer.config.json
```

### 2. Set your workspace directories

Edit `ai-limit-timer.config.json`. The critical setting is `workspaceDir` for each provider — this is the directory the CLI runs in when sending the keep-alive prompt.

```json
{
  "codex": {
    "workspaceDir": "/path/to/any/project"
  },
  "claude": {
    "workspaceDir": "/path/to/a/trusted/project"
  }
}
```

**Important:** For Claude, use a directory you've already opened and trusted in interactive mode. Otherwise the trust prompt will block the automated run.

### 3. Build and first run

```bash
npm install
npm run build
npm run run
```

This will:
- Check current reset times for both providers
- Send a keep-alive prompt if any window has already reset
- Save state to `./var/state.json`
- Install the next wake via **launchd** (macOS) or **systemd** user units (Linux), per `scheduler` in your config

### 4. Verify

```bash
npm run status
```

You should see output like:

```
Codex: session-log
  5h reset: 3/17/2026, 10:05:20 AM
  weekly reset: 3/18/2026, 11:39:57 PM
Claude: stream-json
  5h reset: 3/17/2026, 7:00:00 AM
  weekly reset: 4/1/2026, 12:00:00 AM
Next run: 3/17/2026, 7:01:00 AM
```

From here, the timer manages itself. It will wake up after each reset, send the keep-alive prompt, and schedule the next run.

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` (required before `run` in a fresh clone) |
| `npm run run` | Execute one cycle: check resets, prime if due, schedule next run |
| `npm run status` | Show current reset times and next scheduled run |
| `npm run status -- --json` | Output status as JSON |
| `npm run timer:install` | Install/update the scheduler job (launchd or systemd) from saved state |
| `npm run timer:uninstall` | Remove the scheduled job (launchd or systemd) |
| `npm run install-launchd` | Same as `timer:install` when `scheduler.type` is `launchd` (macOS) |
| `npm run uninstall-launchd` | Same as `timer:uninstall` for `launchd` |
| `npm run install-systemd` | Same as `timer:install` when `scheduler.type` is `systemd` (Linux) |
| `npm run uninstall-systemd` | Same as `timer:uninstall` for `systemd` |
| `npm run typecheck` | Typecheck only (no `dist/` write) |
| `npm test` | Build, then run unit tests (`parsers`, scheduler helpers, config/env, spawn errors) |

**Note:** A plain `npm install` in this project only installs Node dependencies. It does **not** register OS jobs — use `npm run timer:install` (after `build`) for that. The `npm` lifecycle name `install` is intentionally **not** used as a script name, so `npm install` does not run `launchd` or `systemd` registration.

**CI** (GitHub Actions on `main` / PRs): `npm test` on Ubuntu and macOS (Node 20 and 22), plus a `docker build` smoke check on Linux.

## Docker (in-repo image)

- **Build:** `docker build -t ai-limit-timer:local .`
- **Run, mounts, `codex` / `claude`, `AI_LIMIT_TIMER_CONFIG`:** see **[docs/docker.md](docs/docker.md)**.

The repo ships a `Dockerfile` only (no public registry in this release). Pushing a versioned image (e.g. GHCR) is tracked as a separate milestone in the project.

### Environment variables

| Variable | Effect |
|----------|--------|
| `AI_LIMIT_TIMER_CONFIG` | Path to the JSON config file if you do **not** pass `--config`. Handy in Docker, systemd units, or CI. The CLI still wins: `--config` overrides this. |

## Configuration

All settings in `ai-limit-timer.config.json` (or the path in `--config` / **`AI_LIMIT_TIMER_CONFIG`**). You must set each enabled provider’s **`workspaceDir`**; everything else has defaults chosen for your OS (`scheduler.type` defaults to `launchd` on macOS and `systemd` on Linux).

```jsonc
{
  // Where to store state, logs, and transcripts
  "stateDir": "./var",

  "scheduler": {
    // "launchd" on macOS, "systemd" on Linux (defaults if omitted: darwin -> launchd, linux -> systemd)
    "type": "launchd",
    "label": "com.shnksi.ai-limit-timer",
    "launchAgentPath": "~/Library/LaunchAgents/com.shnksi.ai-limit-timer.plist",
    "userUnitDir": "~/.config/systemd/user",
    "runDelayAfterResetSeconds": 60
  },

  "codex": {
    "enabled": true,
    "command": "codex",
    // Where Codex stores session logs
    "sessionRoot": "~/.codex/sessions",
    // Working directory for the keep-alive prompt
    "workspaceDir": ".",
    // The prompt sent to start a fresh window
    "prompt": "Reply with exactly OK.",
    // Kill the prompt if it takes longer than this
    "timeoutMs": 180000,
    // Additional CLI flags passed to codex exec
    "extraArgs": []
  },

  "claude": {
    "enabled": true,
    "command": "claude",
    // Working directory for the keep-alive prompt (must be a trusted workspace)
    "workspaceDir": ".",
    "prompt": "Reply with exactly OK.",
    "timeoutMs": 180000,
    // Flags for the prime command. Defaults disable session persistence,
    // tool access, and Chrome to keep the prompt minimal and fast.
    "primeExtraArgs": [
      "--no-session-persistence",
      "--tools", "",
      "--no-chrome"
    ]
  }
}
```

### Disabling a provider

Set `"enabled": false` to skip either provider entirely:

```json
{
  "codex": { "enabled": false },
  "claude": { "enabled": true, "workspaceDir": "/my/project" }
}
```

## File Structure

```
optimize-ai-limits/
├── .github/
│   └── workflows/
│       └── ci.yml              # npm test + docker build
├── Dockerfile
├── .dockerignore
├── tsconfig.json
├── src/
│   ├── ai-limit-timer.ts      # CLI entry, orchestration, providers
│   ├── config.ts
│   ├── hardening.ts
│   ├── parsers.ts
│   ├── run-child.ts
│   └── scheduler/
│       ├── launchd.ts
│       ├── shared.ts
│       └── systemd.ts
├── docs/
│   └── docker.md
├── CONTRIBUTING.md
├── dist/                       # tsc output (not committed)
├── test/
│   ├── parsers.test.ts
│   ├── scheduler.test.ts
│   └── config-path.test.ts
├── var/                        # Runtime data (gitignored)
│   ├── state.json
│   ├── logs/                   # Per-run codex-prime / claude-prime logs
│   ├── launchd.stdout.log     # macOS, when using launchd
│   ├── launchd.stderr.log
│   ├── systemd.stdout.log     # Linux, when using systemd
│   └── systemd.stderr.log
├── ai-limit-timer.config.example.json
├── ai-limit-timer.config.json  # Local config (gitignored)
├── package.json
├── package-lock.json
└── LICENSE
```

## Troubleshooting

**Codex shows "prime-fallback" instead of "session-log"**
Codex doesn't always include rate-limit timestamps in session logs for small prompts. The timer still works — it estimates `now + 5h` and schedules accordingly. You'll get exact timestamps again once you use Codex interactively and it writes `rate_limits` data to its session logs.

**Claude prime fails or times out**
- Ensure `workspaceDir` points to a directory you've previously trusted in Claude Code's interactive mode.
- Check `./var/logs/claude-prime-*.log` for the full stdout/stderr.

**Could not start `"codex"` or `"claude"`: not on PATH or not executable**
Install the tools or set an **absolute** path in `codex.command` / `claude.command`. The app does not use a shell; only a real executable path or a name found on your `PATH` will work.

**"launchd scheduling requires a local macOS user session"**
The tool must run as a logged-in user, not as root or via SSH without a GUI session. `launchd` user agents require a GUI login context.

**`systemd` / `systemctl --user` fails (Linux)**
The scheduled units install under the **user** manager. You need a logind user session, `XDG_RUNTIME_DIR` set, and often `loginctl enable-linger <user>` for headless/SSH hosts. The timer uses `OnCalendar` in **local** time (weekday + date and time) for the next run.

**Next run time seems wrong**
The timer picks the earliest reset across all enabled providers and adds `runDelayAfterResetSeconds` (default: 60s). Check `npm run status -- --json` to see exact timestamps and which provider is driving the schedule.

**Want to see what happened on the last run?**
- **macOS:** `./var/launchd.stdout.log` and `./var/launchd.stderr.log` (scheduler), plus `./var/logs/` for each prime attempt.
- **Linux:** `./var/systemd.stdout.log` and `./var/systemd.stderr.log` (scheduler), plus `./var/logs/` for per-provider runs.

## How the Fallback Works

When exact rate-limit data isn't available — Claude's `stream-json` doesn't contain a `rate_limit_event`, or Codex's session log has `rate_limits: null` for small prompts — the timer uses a conservative fallback for that provider:

- **5-hour window**: estimated as `now + 5 hours`
- **Weekly window**: preserved from the previous known value if it hasn't expired, otherwise estimated as `now + 7 days`

This means the timer will always schedule a next run, even with incomplete data. The worst case is waking up slightly early and sending an extra keep-alive prompt — which is harmless.

## License

[MIT](LICENSE)
