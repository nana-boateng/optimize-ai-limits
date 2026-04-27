import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { assertAbsoluteResolved, assertConfigPathString } from "./hardening.js";

const DEFAULT_CONFIG_FILE = "ai-limit-timer.config.json";
const DEFAULT_STATE_DIR = "var";
const DEFAULT_PROMPT = "Reply with exactly OK.";
const DEFAULT_LAUNCH_LABEL = "com.shnksi.ai-limit-timer";
const DEFAULT_SYSTEMD_USER_UNIT_DIR = "~/.config/systemd/user";

export type SchedulerType = "launchd" | "systemd";

export type CodexConfig = {
  enabled: boolean;
  command: string;
  sessionRoot: string;
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
  extraArgs: string[];
  model?: string;
};

export type ClaudeConfig = {
  enabled: boolean;
  command: string;
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
  primeExtraArgs: string[];
  model?: string;
};

export type SchedulerConfigShared = {
  type: SchedulerType;
  label: string;
  runDelayAfterResetSeconds: number;
  launchAgentPath: string;
  userUnitDir: string;
};

export type AppConfig = {
  stateDir: string;
  scheduler: SchedulerConfigShared;
  codex: CodexConfig;
  claude: ClaudeConfig;
} & { configPath: string };

function expandHome(input: string): string {
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

function absoluteFrom(baseDir: string, maybeRelative: string | undefined | null) {
  if (maybeRelative == null || maybeRelative === "") {
    return maybeRelative ?? "";
  }

  const expanded = expandHome(maybeRelative);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

async function pathExists(targetPath: string) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function defaultSchedulerType(): SchedulerType {
  const p = process.platform;
  if (p === "darwin") {
    return "launchd";
  }
  if (p === "linux") {
    return "systemd";
  }
  if (p === "win32") {
    throw new Error("This platform (win32) is not supported. Use WSL, Linux, or macOS per project scope.");
  }
  throw new Error(`Unsupported platform: ${p}. Set scheduler.type in config and use a supported host.`);
}

function defaultConfig(configPath: string) {
  const baseDir = path.dirname(configPath);
  const st = defaultSchedulerType();
  return {
    stateDir: path.resolve(baseDir, DEFAULT_STATE_DIR),
    scheduler: {
      type: st,
      label: DEFAULT_LAUNCH_LABEL,
      launchAgentPath: st === "launchd" ? `~/Library/LaunchAgents/${DEFAULT_LAUNCH_LABEL}.plist` : "",
      userUnitDir: DEFAULT_SYSTEMD_USER_UNIT_DIR,
      runDelayAfterResetSeconds: 60,
    },
    codex: {
      enabled: true,
      command: "codex",
      sessionRoot: "~/.codex/sessions",
      workspaceDir: baseDir,
      prompt: DEFAULT_PROMPT,
      timeoutMs: 180000,
      extraArgs: [] as string[],
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

type RawConfig = Record<string, unknown> | null;

function mergeConfig(
  baseConfig: ReturnType<typeof defaultConfig>,
  overrideConfig: RawConfig,
): ReturnType<typeof defaultConfig> {
  if (!overrideConfig || typeof overrideConfig !== "object") {
    return baseConfig;
  }

  const o = overrideConfig as Record<string, unknown>;
  const oScheduler = o.scheduler as Record<string, unknown> | undefined;
  const oCodex = o.codex as Record<string, unknown> | undefined;
  const oClaude = o.claude as Record<string, unknown> | undefined;

  return {
    ...baseConfig,
    ...o,
    scheduler: {
      ...baseConfig.scheduler,
      ...oScheduler,
    },
    codex: {
      ...baseConfig.codex,
      ...oCodex,
    },
    claude: {
      ...baseConfig.claude,
      ...oClaude,
    },
  };
}

function validateSchedulerType(value: string): value is SchedulerType {
  return value === "launchd" || value === "systemd";
}

export function assertSchedulerMatchesPlatform(config: AppConfig) {
  const p = process.platform;
  if (p === "darwin" && config.scheduler.type !== "launchd") {
    throw new Error(`On macOS, scheduler.type must be "launchd" (got "${config.scheduler.type}").`);
  }
  if (p === "linux" && config.scheduler.type !== "systemd") {
    throw new Error(`On Linux, scheduler.type must be "systemd" (got "${config.scheduler.type}").`);
  }
  if (p !== "linux" && p !== "darwin") {
    throw new Error("Supported platforms for scheduling: macOS (launchd) and Linux (systemd).");
  }
}

function finalizeConfig(config: ReturnType<typeof defaultConfig> & { configPath?: string }, configPath: string): AppConfig {
  const baseDir = path.dirname(configPath);
  if (!config.scheduler || typeof config.scheduler.type !== "string" || !validateSchedulerType(config.scheduler.type)) {
    throw new Error('Invalid or missing scheduler.type; use "launchd" or "systemd".');
  }
  if (config.scheduler.type === "systemd" && (typeof config.scheduler.userUnitDir !== "string" || !config.scheduler.userUnitDir)) {
    throw new Error("Invalid scheduler.userUnitDir for systemd.");
  }
  if (typeof config.stateDir !== "string") {
    throw new Error("Invalid stateDir in config.");
  }
  if (!config.codex || !config.claude) {
    throw new Error("Config must include codex and claude blocks.");
  }

  const sched = config.scheduler;
  const userUnitDir = absoluteFrom(baseDir, sched.userUnitDir) as string;
  assertConfigPathString(userUnitDir, "scheduler.userUnitDir");
  assertAbsoluteResolved(userUnitDir, "scheduler.userUnitDir");

  let launchAgentPath = "";
  if (sched.type === "launchd") {
    if (typeof sched.launchAgentPath !== "string" || !sched.launchAgentPath) {
      throw new Error("Invalid scheduler.launchAgentPath for launchd.");
    }
    launchAgentPath = absoluteFrom(baseDir, sched.launchAgentPath) as string;
    assertConfigPathString(launchAgentPath, "scheduler.launchAgentPath");
    assertAbsoluteResolved(launchAgentPath, "scheduler.launchAgentPath");
  } else if (typeof sched.launchAgentPath === "string" && sched.launchAgentPath) {
    launchAgentPath = absoluteFrom(baseDir, sched.launchAgentPath) as string;
  }

  return {
    ...config,
    configPath,
    stateDir: absoluteFrom(baseDir, config.stateDir) as string,
    scheduler: {
      ...config.scheduler,
      type: config.scheduler.type,
      launchAgentPath,
      userUnitDir,
    },
    codex: {
      ...config.codex,
      sessionRoot: absoluteFrom(baseDir, config.codex.sessionRoot) as string,
      workspaceDir: absoluteFrom(baseDir, config.codex.workspaceDir) as string,
    },
    claude: {
      ...config.claude,
      workspaceDir: absoluteFrom(baseDir, config.claude.workspaceDir) as string,
    },
  };
}

export { DEFAULT_CONFIG_FILE, DEFAULT_PROMPT, DEFAULT_LAUNCH_LABEL };

/**
 * Resolves the config file path. Precedence: CLI `--config`, then `AI_LIMIT_TIMER_CONFIG`, then `ai-limit-timer.config.json`.
 */
export function resolveConfigPathFromEnv(cliConfigPath: string | null) {
  if (cliConfigPath != null && cliConfigPath !== "") {
    return cliConfigPath;
  }
  const fromEnv = process.env.AI_LIMIT_TIMER_CONFIG?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_CONFIG_FILE;
}

export async function loadConfig(configPathArg: string | null) {
  const configPath = absoluteFrom(process.cwd(), resolveConfigPathFromEnv(configPathArg));
  const base = defaultConfig(configPath);
  if (await pathExists(configPath)) {
    const raw = await fsp.readFile(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      const err = error as Error;
      throw new Error(`Invalid JSON in config file ${configPath}: ${err.message}`);
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Config at ${configPath} must be a JSON object.`);
    }
    return finalizeConfig(mergeConfig(base, parsed as Record<string, unknown>), configPath);
  }

  return finalizeConfig(base, configPath);
}
