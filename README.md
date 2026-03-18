# AI Limit Timer

Automatically maximize your token usage on Anthropic's AI coding tools by ensuring you never lose time to rate-limit reset windows.

## Why This Exists

Codex CLI and Claude Code both enforce rolling rate limits: a **5-hour window** and a **weekly window**. When you hit a limit, the timer counts down to a reset — but the fresh allocation only begins when you **actually send your next prompt**. If your 5-hour window resets at 6:00 AM and you don't open your terminal until 9:00 AM, you've silently lost 3 hours of available capacity.

This tool fixes that. It:

1. **Reads exact reset timestamps** from Codex session logs and Claude's stream output
2. **Sends a minimal keep-alive prompt** ("Reply with exactly OK.") right after each reset, so your next window starts immediately
3. **Self-schedules via macOS `launchd`** to wake up at the next reset time — no cron jobs, no always-on process

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
│  4. Write launchd plist → sleep until then + 60s     │
│                                                      │
│  5. launchd wakes us → go to step 1                  │
└──────────────────────────────────────────────────────┘
```

### Data Sources

| Provider | Source | Accuracy |
|----------|--------|----------|
| **Codex** | `~/.codex/sessions/**/*.jsonl` — `token_count` payloads with `rate_limits.primary.resets_at` and `rate_limits.secondary.resets_at` | Exact — reads Codex's own persisted timestamps |
| **Claude** | `claude -p --output-format stream-json` — `rate_limit_event` objects with `resetsAt` and `overageResetsAt` | Best-effort — if stream-json doesn't contain rate-limit events, falls back to `now + 5h` for the primary window and preserves the previous weekly reset |

## Requirements

- **macOS** (uses `launchd` for scheduling)
- **Node.js** v18+
- **Codex CLI** (`codex`) — [install guide](https://github.com/openai/codex)
- **Claude Code** (`claude`) — [install guide](https://docs.anthropic.com/en/docs/claude-code)

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/shnksi/ai-limit-timer.git
cd ai-limit-timer
```

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

### 3. First run

```bash
npm run run
```

This will:
- Check current reset times for both providers
- Send a keep-alive prompt if any window has already reset
- Save state to `./var/state.json`
- Install a `launchd` job to wake up at the next reset time

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
| `npm run run` | Execute one cycle: check resets, prime if due, schedule next run |
| `npm run status` | Show current reset times and next scheduled run |
| `npm run status -- --json` | Output status as JSON |
| `npm run install` | Install/update the `launchd` daemon from saved state |
| `npm run uninstall` | Remove the `launchd` daemon |
| `npm test` | Run parser unit tests |

## Configuration

All settings in `ai-limit-timer.config.json`. Only `workspaceDir` is required — everything else has sensible defaults.

```jsonc
{
  // Where to store state, logs, and transcripts
  "stateDir": "./var",

  "scheduler": {
    "type": "launchd",
    // Unique identifier for the launchd job
    "label": "com.shnksi.ai-limit-timer",
    // Where the plist file gets written
    "launchAgentPath": "~/Library/LaunchAgents/com.shnksi.ai-limit-timer.plist",
    // Seconds to wait after a reset before sending the keep-alive prompt.
    // Avoids hitting the exact transition boundary.
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
ai-limit-timer/
├── src/
│   ├── ai-limit-timer.mjs    # Main entrypoint: CLI, scheduling, orchestration
│   └── parsers.mjs            # Extracts reset timestamps from Codex/Claude output
├── test/
│   └── parsers.test.mjs       # Unit tests for parsers
├── var/                        # Runtime data (gitignored)
│   ├── state.json              # Persisted reset times and next run
│   ├── logs/                   # Stdout/stderr from each keep-alive prompt
│   └── transcripts/            # Raw Claude usage captures
├── ai-limit-timer.config.example.json
├── ai-limit-timer.config.json  # Your local config (gitignored)
├── package.json
└── LICENSE
```

## Troubleshooting

**"Codex prime completed but no rate-limit data was found"**
Codex hasn't written rate-limit data to its session logs yet. Run Codex manually once so it creates a session with `token_count` payloads, then retry.

**Claude prime fails or times out**
- Ensure `workspaceDir` points to a directory you've previously trusted in Claude Code's interactive mode.
- Check `./var/logs/claude-prime-*.log` for the full stdout/stderr.

**"launchd scheduling requires a local macOS user session"**
The tool must run as a logged-in user, not as root or via SSH without a GUI session. `launchd` user agents require a GUI login context.

**Next run time seems wrong**
The timer picks the earliest reset across all providers and adds `runDelayAfterResetSeconds` (default: 60s). Check `npm run status -- --json` to see exact timestamps and verify which provider is driving the schedule.

**Want to see what happened on the last run?**
Check `./var/launchd.stdout.log` and `./var/launchd.stderr.log` for the launchd-triggered output, or browse `./var/logs/` for per-provider execution logs.

## How the Fallback Works

When Claude's `stream-json` output doesn't contain a `rate_limit_event` (which happens when the response completes before rate-limit info is emitted), the timer uses a conservative fallback:

- **5-hour window**: estimated as `now + 5 hours`
- **Weekly window**: preserved from the previous known value if it hasn't expired, otherwise estimated as `now + 7 days`

This means the timer will always schedule a next run, even with incomplete data. The worst case is waking up slightly early and sending an extra keep-alive prompt — which is harmless.

## License

[MIT](LICENSE)
