#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  parseClaudeStreamJson,
  parseCodexRateLimitsJsonl,
} from "./parsers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_CONFIG_FILE = "ai-limit-timer.config.json";
const DEFAULT_STATE_DIR = "var";
const DEFAULT_PROMPT = "Reply with exactly OK.";
const DEFAULT_LAUNCH_LABEL = "com.shnksi.ai-limit-timer";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_STATUS_POLL_INTERVAL_MS = 1000;
const CODEX_STATUS_POLL_TIMEOUT_MS = 15000;

function expandHome(input) {
  if (!input) {
    return input;
  }

  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function absoluteFrom(baseDir, maybeRelative) {
  if (!maybeRelative) {
    return maybeRelative;
  }

  const expanded = expandHome(maybeRelative);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function withIsoFields(status) {
  if (!status) {
    return null;
  }

  const normalizeWindow = (window) =>
    window
      ? {
          ...window,
          resetsAtIso: new Date(window.resetsAtMs).toISOString(),
        }
      : null;

  return {
    ...status,
    primary: normalizeWindow(status.primary),
    secondary: normalizeWindow(status.secondary),
  };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function defaultConfig(configPath) {
  const baseDir = path.dirname(configPath);
  return {
    stateDir: path.resolve(baseDir, DEFAULT_STATE_DIR),
    scheduler: {
      type: "launchd",
      label: DEFAULT_LAUNCH_LABEL,
      launchAgentPath: `~/Library/LaunchAgents/${DEFAULT_LAUNCH_LABEL}.plist`,
      runDelayAfterResetSeconds: 60,
    },
    codex: {
      enabled: true,
      command: "codex",
      sessionRoot: "~/.codex/sessions",
      workspaceDir: baseDir,
      prompt: DEFAULT_PROMPT,
      timeoutMs: 180000,
      extraArgs: [],
    },
    claude: {
      enabled: true,
      command: "claude",
      workspaceDir: baseDir,
      prompt: DEFAULT_PROMPT,
      timeoutMs: 180000,
      primeExtraArgs: ["--no-session-persistence", "--tools", "", "--no-chrome"],
    },
  };
}

function mergeConfig(baseConfig, overrideConfig) {
  if (!overrideConfig || typeof overrideConfig !== "object") {
    return baseConfig;
  }

  const merged = {
    ...baseConfig,
    ...overrideConfig,
    scheduler: {
      ...baseConfig.scheduler,
      ...overrideConfig.scheduler,
    },
    codex: {
      ...baseConfig.codex,
      ...overrideConfig.codex,
    },
    claude: {
      ...baseConfig.claude,
      ...overrideConfig.claude,
    },
  };

  return merged;
}

async function loadConfig(configPathArg) {
  const configPath = absoluteFrom(process.cwd(), configPathArg ?? DEFAULT_CONFIG_FILE);
  const config = defaultConfig(configPath);
  if (await pathExists(configPath)) {
    const raw = await fsp.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return finalizeConfig(mergeConfig(config, parsed), configPath);
  }

  return finalizeConfig(config, configPath);
}

function finalizeConfig(config, configPath) {
  const baseDir = path.dirname(configPath);
  return {
    ...config,
    configPath,
    stateDir: absoluteFrom(baseDir, config.stateDir),
    scheduler: {
      ...config.scheduler,
      launchAgentPath: absoluteFrom(baseDir, config.scheduler.launchAgentPath),
    },
    codex: {
      ...config.codex,
      sessionRoot: absoluteFrom(baseDir, config.codex.sessionRoot),
      workspaceDir: absoluteFrom(baseDir, config.codex.workspaceDir),
    },
    claude: {
      ...config.claude,
      workspaceDir: absoluteFrom(baseDir, config.claude.workspaceDir),
    },
  };
}

async function loadState(config) {
  const statePath = path.join(config.stateDir, "state.json");
  if (!(await pathExists(statePath))) {
    return {
      statePath,
      data: {
        version: 1,
        providers: {},
      },
    };
  }

  const raw = await fsp.readFile(statePath, "utf8");
  return {
    statePath,
    data: JSON.parse(raw),
  };
}

async function saveState(statePath, data) {
  await ensureDir(path.dirname(statePath));
  await fsp.writeFile(statePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function summarizeNextResetMs(status) {
  const candidates = [status?.primary?.resetsAtMs, status?.secondary?.resetsAtMs].filter(Number.isFinite);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function isDue(status, nowMs) {
  const candidates = [status?.primary?.resetsAtMs, status?.secondary?.resetsAtMs].filter(Number.isFinite);
  if (candidates.length === 0) {
    return true;
  }

  return candidates.some((value) => value <= nowMs);
}

function formatDate(ms) {
  return ms ? new Date(ms).toLocaleString() : "unknown";
}

async function listFilesRecursively(rootDir, predicate) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!predicate || predicate(absolutePath, entry)) {
        results.push(absolutePath);
      }
    }
  }

  return results;
}

async function findLatestFile(rootDir, predicate) {
  const files = await listFilesRecursively(rootDir, predicate);
  if (files.length === 0) {
    return null;
  }

  let latestFile = null;
  let latestMtime = 0;
  for (const filePath of files) {
    const stats = await fsp.stat(filePath);
    if (stats.mtimeMs > latestMtime) {
      latestFile = filePath;
      latestMtime = stats.mtimeMs;
    }
  }

  return latestFile;
}

async function inspectCodexStatus(config) {
  const latestFile = await findLatestFile(
    config.codex.sessionRoot,
    (filePath) => filePath.endsWith(".jsonl"),
  );

  if (!latestFile) {
    return null;
  }

  const text = await fsp.readFile(latestFile, "utf8");
  const parsed = parseCodexRateLimitsJsonl(text, latestFile);
  return parsed ? withIsoFields(parsed) : null;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...(options.env ?? {}) };

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function writeCommandLog(stateDir, filePrefix, result) {
  await ensureDir(path.join(stateDir, "logs"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(stateDir, "logs", `${filePrefix}-${timestamp}.log`);
  const content = [
    `exit_code=${result.code}`,
    `timed_out=${result.timedOut}`,
    "",
    "stdout:",
    result.stdout.trimEnd(),
    "",
    "stderr:",
    result.stderr.trimEnd(),
    "",
  ].join("\n");
  await fsp.writeFile(logPath, content, "utf8");
  return logPath;
}

async function primeCodex(config, stateDir) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    config.codex.workspaceDir,
    ...config.codex.extraArgs,
  ];

  if (config.codex.model) {
    args.push("-m", config.codex.model);
  }

  args.push(config.codex.prompt || DEFAULT_PROMPT);

  const result = await runCommand(config.codex.command, args, {
    cwd: config.codex.workspaceDir,
    timeoutMs: config.codex.timeoutMs,
  });

  const logPath = await writeCommandLog(stateDir, "codex-prime", result);
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Codex prime failed. See ${logPath}`);
  }

  const deadline = Date.now() + CODEX_STATUS_POLL_TIMEOUT_MS;
  let status = null;
  while (Date.now() <= deadline) {
    status = await inspectCodexStatus(config);
    if (status?.primary || status?.secondary) {
      break;
    }

    await sleep(CODEX_STATUS_POLL_INTERVAL_MS);
  }

  return {
    logPath,
    status,
  };
}

async function primeClaude(config, stateDir) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--add-dir",
    config.claude.workspaceDir,
    ...config.claude.primeExtraArgs,
  ];

  if (config.claude.model) {
    args.push("--model", config.claude.model);
  }

  args.push(config.claude.prompt || DEFAULT_PROMPT);

  const result = await runCommand(config.claude.command, args, {
    cwd: config.claude.workspaceDir,
    timeoutMs: config.claude.timeoutMs,
  });

  const logPath = await writeCommandLog(stateDir, "claude-prime", result);
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Claude prime failed. See ${logPath}`);
  }

  const parsed = parseClaudeStreamJson(result.stdout);
  return {
    logPath,
    parsed,
  };
}

function buildFallbackStatus(provider, previousStatus, nowMs, metadata = {}) {
  const nextWeeklyMs =
    previousStatus?.secondary?.resetsAtMs && previousStatus.secondary.resetsAtMs > nowMs
      ? previousStatus.secondary.resetsAtMs
      : nowMs + WEEK_MS;

  return withIsoFields({
    provider,
    source: metadata.source ?? "cache-fallback",
    checkedAt: new Date(nowMs).toISOString(),
    rawPath: metadata.rawPath ?? null,
    debugPath: metadata.debugPath ?? null,
    note: metadata.note ?? "Used the local fallback window model.",
    primary: {
      kind: "primary",
      label: "5h",
      windowMinutes: 300,
      usedPercent: null,
      resetsAtMs: nowMs + FIVE_HOURS_MS,
    },
    secondary: {
      kind: "secondary",
      label: "weekly",
      windowMinutes: 10080,
      usedPercent: null,
      resetsAtMs: nextWeeklyMs,
    },
  });
}

function completeClaudeStatus(parsedStatus, previousStatus, nowMs, metadata = {}) {
  if (!parsedStatus) {
    return buildFallbackStatus("claude", previousStatus, nowMs, metadata);
  }

  const fallback = buildFallbackStatus("claude", previousStatus, nowMs, metadata);
  const completed = withIsoFields({
    ...parsedStatus,
    rawPath: metadata.rawPath ?? parsedStatus.rawPath ?? null,
    debugPath: metadata.debugPath ?? parsedStatus.debugPath ?? null,
    note: metadata.note ?? parsedStatus.note ?? null,
    primary: parsedStatus.primary ?? fallback.primary,
    secondary: parsedStatus.secondary ?? fallback.secondary,
  });

  if (!parsedStatus.secondary && previousStatus?.secondary?.resetsAtMs > nowMs) {
    completed.secondary = {
      ...previousStatus.secondary,
      resetsAtIso: new Date(previousStatus.secondary.resetsAtMs).toISOString(),
    };
  }

  return completed;
}

function computeNextRunAtMs(providerStates, nowMs, delayMs) {
  const candidates = providerStates
    .map((providerState) => summarizeNextResetMs(providerState?.current))
    .filter((value) => Number.isFinite(value) && value + delayMs > nowMs)
    .map((value) => value + delayMs);

  if (candidates.length === 0) {
    return nowMs + Math.max(delayMs, 60 * 60 * 1000);
  }

  return Math.max(Math.min(...candidates), nowMs + Math.max(delayMs, 60 * 1000));
}

function buildLaunchdPlist(config, nextRunMs, scriptPath) {
  const nextRun = new Date(nextRunMs);
  const stdoutPath = path.join(config.stateDir, "launchd.stdout.log");
  const stderrPath = path.join(config.stateDir, "launchd.stderr.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${config.scheduler.label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${process.execPath}</string>
      <string>${scriptPath}</string>
      <string>run</string>
      <string>--config</string>
      <string>${config.configPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Minute</key>
      <integer>${nextRun.getMinutes()}</integer>
      <key>Hour</key>
      <integer>${nextRun.getHours()}</integer>
      <key>Day</key>
      <integer>${nextRun.getDate()}</integer>
      <key>Month</key>
      <integer>${nextRun.getMonth() + 1}</integer>
    </dict>
  </dict>
</plist>
`;
}

async function runLaunchctl(commandArgs) {
  return runCommand("launchctl", commandArgs, {
    cwd: projectRoot,
    timeoutMs: 30000,
  });
}

async function scheduleNextRun(config, nextRunMs) {
  const scriptPath = path.resolve(__filename);
  const plistPath = config.scheduler.launchAgentPath;
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error("launchd scheduling requires a local macOS user session.");
  }

  await ensureDir(path.dirname(plistPath));
  await ensureDir(config.stateDir);
  await fsp.writeFile(plistPath, buildLaunchdPlist(config, nextRunMs, scriptPath), "utf8");

  await runLaunchctl(["bootout", `gui/${uid}`, plistPath]).catch(() => {});
  const bootstrap = await runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
  if (bootstrap.code !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`);
  }

  return plistPath;
}

async function uninstallLaunchd(config) {
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error("launchd scheduling requires a local macOS user session.");
  }

  const plistPath = config.scheduler.launchAgentPath;
  await runLaunchctl(["bootout", `gui/${uid}`, plistPath]).catch(() => {});
  if (await pathExists(plistPath)) {
    await fsp.unlink(plistPath);
  }

  return plistPath;
}

function printProviderSummary(name, providerState) {
  if (!providerState) {
    console.log(`${name}: unavailable`);
    return;
  }

  console.log(`${name}: ${providerState.source}`);
  console.log(`  5h reset: ${formatDate(providerState.primary?.resetsAtMs)}`);
  console.log(`  weekly reset: ${formatDate(providerState.secondary?.resetsAtMs)}`);
  if (providerState.note) {
    console.log(`  note: ${providerState.note}`);
  }
  if (providerState.rawPath) {
    console.log(`  raw: ${providerState.rawPath}`);
  }
}

async function executeRun(config, state) {
  const nowMs = Date.now();

  // Guard against RunAtLoad re-triggering after a reschedule.
  // If the next run is still in the future and nothing is due, exit early.
  const savedNextRun = state.data.nextRunAtMs;
  if (savedNextRun && savedNextRun > nowMs) {
    const codexDue = config.codex.enabled && isDue(state.data.providers?.codex?.current, nowMs);
    const claudeDue = config.claude.enabled && isDue(state.data.providers?.claude?.current, nowMs);
    if (!codexDue && !claudeDue) {
      console.log(`Next run not due until ${formatDate(savedNextRun)}. Skipping.`);
      return;
    }
  }

  const previousProviders = state.data.providers ?? {};
  const nextState = {
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    providers: {},
  };

  if (config.codex.enabled) {
    try {
      const cachedStatus = previousProviders.codex?.current ?? null;
      let status = await inspectCodexStatus(config);
      if (!status || isDue(status, nowMs)) {
        const primed = await primeCodex(config, config.stateDir);
        status = primed.status ?? buildFallbackStatus("codex", cachedStatus, nowMs, {
          source: "prime-fallback",
          note: `Prime succeeded but no rate-limit data in session log. See ${primed.logPath}`,
        });
      }
      nextState.providers.codex = {
        current: status,
      };
    } catch (error) {
      nextState.providers.codex = {
        current: previousProviders.codex?.current ?? null,
        lastError: String(error.message ?? error),
      };
    }
  }

  if (config.claude.enabled) {
    try {
      const cachedStatus = previousProviders.claude?.current ?? null;
      let status = cachedStatus;
      if (!status || isDue(status, nowMs)) {
        const primed = await primeClaude(config, config.stateDir);
        status = completeClaudeStatus(primed.parsed, cachedStatus, nowMs, {
          source: primed.parsed?.source ?? "cache-fallback",
          note: primed.parsed
            ? `Prime log: ${primed.logPath}`
            : "Claude stream-json did not contain rate_limit_event, fell back to window estimates.",
        });
      }

      nextState.providers.claude = {
        current: status,
      };
    } catch (error) {
      nextState.providers.claude = {
        current: previousProviders.claude?.current ?? null,
        lastError: String(error.message ?? error),
      };
    }
  }

  const delayMs = (config.scheduler.runDelayAfterResetSeconds ?? 60) * 1000;
  const nextRunAtMs = computeNextRunAtMs(
    [nextState.providers.codex, nextState.providers.claude],
    nowMs,
    delayMs,
  );

  nextState.nextRunAtMs = nextRunAtMs;
  nextState.nextRunAtIso = new Date(nextRunAtMs).toISOString();

  await saveState(state.statePath, nextState);
  if (config.scheduler.type === "launchd") {
    nextState.launchAgentPath = await scheduleNextRun(config, nextRunAtMs);
    await saveState(state.statePath, nextState);
  }

  printProviderSummary("Codex", nextState.providers.codex?.current);
  printProviderSummary("Claude", nextState.providers.claude?.current);
  console.log(`Next run: ${formatDate(nextRunAtMs)}`);
}

async function executeStatus(config, state, asJson = false) {
  const codexStatus = config.codex.enabled ? await inspectCodexStatus(config) : null;
  const claudeStatus = state.data.providers.claude?.current ?? null;
  const payload = {
    configPath: config.configPath,
    statePath: state.statePath,
    codex: codexStatus,
    claude: claudeStatus,
    nextRunAtMs: state.data.nextRunAtMs ?? null,
    nextRunAtIso: state.data.nextRunAtIso ?? null,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printProviderSummary("Codex", codexStatus);
  printProviderSummary("Claude", claudeStatus);
  console.log(`Next run: ${state.data.nextRunAtMs ? formatDate(state.data.nextRunAtMs) : "not scheduled"}`);
}

function parseCliArgs(argv) {
  const args = [...argv];
  let command = "run";
  let configPath = null;
  let json = false;

  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--config") {
      configPath = args.shift() ?? null;
      continue;
    }
    if (arg === "--json") {
      json = true;
    }
  }

  return {
    command,
    configPath,
    json,
  };
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig(cli.configPath);
  await ensureDir(config.stateDir);
  const state = await loadState(config);

  switch (cli.command) {
    case "run":
      await executeRun(config, state);
      break;
    case "status":
      await executeStatus(config, state, cli.json);
      break;
    case "install-launchd": {
      const nextRunAtMs = state.data.nextRunAtMs ?? Date.now() + 60 * 1000;
      const plistPath = await scheduleNextRun(config, nextRunAtMs);
      console.log(`Installed launchd job at ${plistPath}`);
      console.log(`Next run: ${formatDate(nextRunAtMs)}`);
      break;
    }
    case "uninstall-launchd": {
      const plistPath = await uninstallLaunchd(config);
      console.log(`Removed launchd job at ${plistPath}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${cli.command}`);
  }
}

main().catch((error) => {
  console.error(error.message ?? String(error));
  process.exitCode = 1;
});
