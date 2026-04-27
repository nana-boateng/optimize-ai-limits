#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertSchedulerMatchesPlatform, type AppConfig, loadConfig } from "./config.js";
import { assertExecutablePathOrName } from "./hardening.js";
import { parseClaudeStreamJson, parseCodexRateLimitsJsonl } from "./parsers.js";
import { runCommand } from "./run-child.js";
import { scheduleNextLaunchd, uninstallLaunchd } from "./scheduler/launchd.js";
import { ensureDir, pathExists } from "./scheduler/shared.js";
import { scheduleNextSystemd, uninstallSystemd } from "./scheduler/systemd.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");
const scriptPath = __filename;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_STATUS_POLL_INTERVAL_MS = 1000;
const CODEX_STATUS_POLL_TIMEOUT_MS = 15000;

function withIsoFields(
  status: {
    primary?: { resetsAtMs: number; [k: string]: unknown } | null;
    secondary?: { resetsAtMs: number; [k: string]: unknown } | null;
    [k: string]: unknown;
  } | null,
) {
  if (!status) {
    return null;
  }

  const normalizeWindow = (window: (typeof status)["primary"]) =>
    window
      ? {
          ...window,
          resetsAtIso: new Date((window as { resetsAtMs: number }).resetsAtMs).toISOString(),
        }
      : null;

  return {
    ...status,
    primary: normalizeWindow(status.primary),
    secondary: normalizeWindow(status.secondary),
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type ProviderState = {
  current: unknown;
  lastError?: string;
};

type StateData = {
  version: number;
  nextRunAtMs?: number;
  nextRunAtIso?: string;
  providers: Record<string, ProviderState>;
  updatedAt?: string;
  launchAgentPath?: string;
  systemd?: { servicePath: string; timerPath: string };
};

async function loadState(config: AppConfig) {
  const statePath = path.join(config.stateDir, "state.json");
  if (!(await pathExists(statePath))) {
    return {
      statePath,
      data: {
        version: 1,
        providers: {},
      } as StateData,
    };
  }

  const raw = await fsp.readFile(statePath, "utf8");
  let data: StateData;
  try {
    data = JSON.parse(raw) as StateData;
  } catch (error) {
    const err = error as Error;
    throw new Error(`Invalid JSON in state file ${statePath}: ${err.message}`);
  }
  return { statePath, data };
}

async function saveState(statePath: string, data: StateData) {
  await ensureDir(path.dirname(statePath));
  await fsp.writeFile(statePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function summarizeNextResetMs(status: { primary?: { resetsAtMs: number } | null; secondary?: { resetsAtMs: number } | null } | null) {
  const candidates = [status?.primary?.resetsAtMs, status?.secondary?.resetsAtMs].filter(Number.isFinite) as number[];
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function isDue(
  status: { primary?: { resetsAtMs: number } | null; secondary?: { resetsAtMs: number } | null } | null,
  nowMs: number,
) {
  const candidates = [status?.primary?.resetsAtMs, status?.secondary?.resetsAtMs].filter(Number.isFinite) as number[];
  if (candidates.length === 0) {
    return true;
  }

  return candidates.some((value) => value <= nowMs);
}

function formatDate(ms: number | null | undefined) {
  return ms ? new Date(ms).toLocaleString() : "unknown";
}

async function listFilesRecursively(rootDir: string, predicate?: (filePath: string, entry: { isDirectory: () => boolean; name: string }) => boolean) {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }
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

async function findLatestFile(
  rootDir: string,
  predicate: (filePath: string, entry: { isDirectory: () => boolean; name: string }) => boolean,
) {
  const files = await listFilesRecursively(rootDir, predicate);
  if (files.length === 0) {
    return null;
  }

  let latestFile: string | null = null;
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

async function inspectCodexStatus(config: AppConfig) {
  const latestFile = await findLatestFile(
    String(config.codex.sessionRoot),
    (filePath) => filePath.endsWith(".jsonl"),
  );

  if (!latestFile) {
    return null;
  }

  const text = await fsp.readFile(latestFile, "utf8");
  const parsed = parseCodexRateLimitsJsonl(text, latestFile);
  return parsed ? withIsoFields(parsed as Parameters<typeof withIsoFields>[0]) : null;
}

async function writeCommandLog(
  stateDir: string,
  filePrefix: string,
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
) {
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

async function primeCodex(config: AppConfig, stateDir: string) {
  assertExecutablePathOrName(config.codex.command, "codex.command");
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

  const DEFAULT_PROMPT = "Reply with exactly OK.";
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
  let status: ReturnType<typeof withIsoFields> = null;
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

async function primeClaude(config: AppConfig, stateDir: string) {
  assertExecutablePathOrName(config.claude.command, "claude.command");
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

  const DEFAULT_PROMPT = "Reply with exactly OK.";
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

function buildFallbackStatus(
  provider: string,
  previousStatus: { secondary?: { resetsAtMs: number } | null } | null,
  nowMs: number,
  metadata: { source?: string; rawPath?: string | null; debugPath?: string | null; note?: string } = {},
) {
  const sec = previousStatus?.secondary;
  const nextWeeklyMs = sec && sec.resetsAtMs > nowMs ? sec.resetsAtMs : nowMs + WEEK_MS;

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
  } as Parameters<typeof withIsoFields>[0]);
}

function completeClaudeStatus(
  parsedStatus: ReturnType<typeof parseClaudeStreamJson> | null,
  previousStatus: { secondary?: { resetsAtMs: number } | null; primary?: unknown } | null,
  nowMs: number,
  metadata: { source?: string; rawPath?: string | null; debugPath?: string | null; note?: string } = {},
) {
  if (!parsedStatus) {
    return buildFallbackStatus("claude", previousStatus, nowMs, metadata);
  }

  const fallback = buildFallbackStatus("claude", previousStatus, nowMs, metadata);
  const ext = parsedStatus as typeof parsedStatus & { rawPath?: string | null; debugPath?: string | null; note?: string | null };
  const completed = withIsoFields({
    ...parsedStatus,
    rawPath: metadata.rawPath ?? ext.rawPath ?? null,
    debugPath: metadata.debugPath ?? ext.debugPath ?? null,
    note: metadata.note ?? ext.note ?? null,
    primary: parsedStatus.primary ?? fallback?.primary,
    secondary: parsedStatus.secondary ?? fallback?.secondary,
  } as Parameters<typeof withIsoFields>[0]);
  if (!parsedStatus.secondary && previousStatus?.secondary && previousStatus.secondary.resetsAtMs > nowMs) {
    (completed as { secondary: unknown }).secondary = {
      ...previousStatus.secondary,
      resetsAtIso: new Date(previousStatus.secondary.resetsAtMs).toISOString(),
    };
  }

  return completed;
}

function computeNextRunAtMs(
  providerStates: (ProviderState | { current?: { primary?: { resetsAtMs: number } } } | undefined)[],
  nowMs: number,
  delayMs: number,
) {
  const candidates = providerStates
    .map((providerState) => summarizeNextResetMs(providerState?.current as Parameters<typeof summarizeNextResetMs>[0]))
    .filter((value) => Number.isFinite(value) && (value as number) + delayMs > nowMs)
    .map((value) => (value as number) + delayMs);

  if (candidates.length === 0) {
    return nowMs + Math.max(delayMs, 60 * 60 * 1000);
  }

  return Math.max(Math.min(...candidates), nowMs + Math.max(delayMs, 60 * 1000));
}

function printProviderSummary(name: string, providerState: { source?: string; note?: string; rawPath?: string; primary?: { resetsAtMs: number } | null; secondary?: { resetsAtMs: number } | null } | null | undefined) {
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

async function scheduleForPlatform(config: AppConfig, nextRunAtMs: number) {
  if (config.scheduler.type === "launchd") {
    return { kind: "launchd" as const, path: await scheduleNextLaunchd(config, nextRunAtMs, scriptPath, projectRoot) };
  }
  if (config.scheduler.type === "systemd") {
    return { kind: "systemd" as const, unitPaths: await scheduleNextSystemd(config, nextRunAtMs, scriptPath, projectRoot) };
  }
  throw new Error(`Unsupported scheduler.type: ${(config.scheduler as { type: string }).type}`);
}

async function uninstallForPlatform(config: AppConfig) {
  if (config.scheduler.type === "launchd") {
    return { kind: "launchd" as const, path: await uninstallLaunchd(config, projectRoot) };
  }
  if (config.scheduler.type === "systemd") {
    return { kind: "systemd" as const, unitPaths: await uninstallSystemd(config, projectRoot) };
  }
  throw new Error(`Unsupported scheduler.type: ${(config.scheduler as { type: string }).type}`);
}

async function executeRun(config: AppConfig, state: { statePath: string; data: StateData }) {
  const nowMs = Date.now();

  const savedNextRun = state.data.nextRunAtMs;
  if (savedNextRun && savedNextRun > nowMs) {
    const codexDue = config.codex.enabled && isDue(state.data.providers?.codex?.current as Parameters<typeof isDue>[0], nowMs);
    const claudeDue = config.claude.enabled && isDue(state.data.providers?.claude?.current as Parameters<typeof isDue>[0], nowMs);
    if (!codexDue && !claudeDue) {
      console.log(`Next run not due until ${formatDate(savedNextRun)}. Skipping.`);
      return;
    }
  }

  const previousProviders = state.data.providers ?? {};
  const nextState: StateData = {
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    providers: {},
  };

  if (config.codex.enabled) {
    try {
      const cachedStatus = previousProviders.codex?.current ?? null;
      let status = await inspectCodexStatus(config);
      if (!status || isDue(status as Parameters<typeof isDue>[0], nowMs)) {
        const primed = await primeCodex(config, config.stateDir);
        status = primed.status ?? buildFallbackStatus("codex", cachedStatus as Parameters<typeof buildFallbackStatus>[1], nowMs, {
          source: "prime-fallback",
          note: `Prime succeeded but no rate-limit data in session log. See ${primed.logPath}`,
        });
      }
      nextState.providers.codex = {
        current: status,
      };
    } catch (error) {
      const err = error as Error;
      nextState.providers.codex = {
        current: (previousProviders.codex?.current ?? null) as unknown,
        lastError: String(err.message ?? error),
      };
    }
  }

  if (config.claude.enabled) {
    try {
      const cachedStatus = (previousProviders.claude?.current ?? null) as
        | {
            primary?: { resetsAtMs: number } | null;
            secondary?: { resetsAtMs: number } | null;
          }
        | null;
      let status = cachedStatus as ReturnType<typeof completeClaudeStatus> | null;
      if (!status || isDue(status as Parameters<typeof isDue>[0], nowMs)) {
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
      const err = error as Error;
      nextState.providers.claude = {
        current: (previousProviders.claude?.current ?? null) as unknown,
        lastError: String(err.message ?? error),
      };
    }
  }

  const delayMs = (config.scheduler.runDelayAfterResetSeconds ?? 60) * 1000;
  const nextRunAtMs = computeNextRunAtMs(
    [nextState.providers.codex, nextState.providers.claude] as unknown as (
      | ProviderState
      | { current?: { primary?: { resetsAtMs: number } } }
      | undefined
    )[],
    nowMs,
    delayMs,
  );

  nextState.nextRunAtMs = nextRunAtMs;
  nextState.nextRunAtIso = new Date(nextRunAtMs).toISOString();

  await saveState(state.statePath, nextState);
  const sched = await scheduleForPlatform(config, nextRunAtMs);
  if (sched.kind === "launchd") {
    nextState.launchAgentPath = sched.path;
  } else {
    nextState.systemd = sched.unitPaths;
  }
  await saveState(state.statePath, nextState);

  printProviderSummary("Codex", nextState.providers.codex?.current as Parameters<typeof printProviderSummary>[1]);
  printProviderSummary("Claude", nextState.providers.claude?.current as Parameters<typeof printProviderSummary>[1]);
  console.log(`Next run: ${formatDate(nextRunAtMs)}`);
}

async function executeStatus(config: AppConfig, state: { statePath: string; data: StateData }, asJson: boolean) {
  const codexStatus = config.codex.enabled ? await inspectCodexStatus(config) : null;
  const claudeStatus = (state.data.providers.claude?.current ?? null) as
    | Record<string, unknown>
    | null
    | undefined;
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
  printProviderSummary("Claude", claudeStatus as Parameters<typeof printProviderSummary>[1]);
  console.log(`Next run: ${state.data.nextRunAtMs ? formatDate(state.data.nextRunAtMs) : "not scheduled"}`);
}

function parseCliArgs(argv: string[]) {
  const args = [...argv];
  let command = "run";
  let configPath: string | null = null;
  let json = false;

  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift() as string;
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

function needSchedulerCheck(command: string) {
  return (
    command === "run" ||
    command === "install" ||
    command === "uninstall" ||
    command === "install-launchd" ||
    command === "install-systemd" ||
    command === "uninstall-launchd" ||
    command === "uninstall-systemd"
  );
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig(cli.configPath);
  if (needSchedulerCheck(cli.command)) {
    assertSchedulerMatchesPlatform(config);
  }
  await ensureDir(config.stateDir);
  const state = await loadState(config);

  if (cli.command === "run") {
    await executeRun(config, state);
  } else if (cli.command === "status") {
    await executeStatus(config, state, cli.json);
  } else if (cli.command === "install" || cli.command === "install-launchd" || cli.command === "install-systemd") {
    if (cli.command === "install-launchd" && config.scheduler.type !== "launchd") {
      throw new Error('Command install-launchd requires scheduler.type "launchd" in your config.');
    }
    if (cli.command === "install-systemd" && config.scheduler.type !== "systemd") {
      throw new Error('Command install-systemd requires scheduler.type "systemd" in your config.');
    }
    const nextRunAtMs = state.data.nextRunAtMs ?? Date.now() + 60 * 1000;
    const r = await scheduleForPlatform(config, nextRunAtMs);
    if (r.kind === "launchd") {
      console.log(`Installed launchd job at ${r.path}`);
    } else {
      console.log(`Installed systemd user units at ${r.unitPaths.servicePath} and ${r.unitPaths.timerPath}`);
    }
    console.log(`Next run: ${formatDate(nextRunAtMs)}`);
  } else if (cli.command === "uninstall" || cli.command === "uninstall-launchd" || cli.command === "uninstall-systemd") {
    if (cli.command === "uninstall-launchd" && config.scheduler.type !== "launchd") {
      throw new Error('Command uninstall-launchd requires scheduler.type "launchd" in your config.');
    }
    if (cli.command === "uninstall-systemd" && config.scheduler.type !== "systemd") {
      throw new Error('Command uninstall-systemd requires scheduler.type "systemd" in your config.');
    }
    const u = await uninstallForPlatform(config);
    if (u.kind === "launchd") {
      console.log(`Removed launchd job at ${u.path}`);
    } else {
      console.log(`Removed systemd user units (if present): ${u.unitPaths.servicePath} ${u.unitPaths.timerPath}`);
    }
  } else {
    throw new Error(`Unknown command: ${cli.command}`);
  }
}

main().catch((error) => {
  console.error((error as Error).message ?? String(error));
  process.exitCode = 1;
});
