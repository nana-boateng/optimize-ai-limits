import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { AppConfig } from "../config.js";
import { escapePlistString } from "../hardening.js";
import { runCommand } from "../run-child.js";
import { ensureDir, pathExists } from "./shared.js";

export function buildLaunchdPlist(
  config: AppConfig,
  nextRunMs: number,
  scriptPath: string,
  projectRoot: string,
) {
  const nextRun = new Date(nextRunMs);
  const stdoutPath = path.join(config.stateDir, "launchd.stdout.log");
  const stderrPath = path.join(config.stateDir, "launchd.stderr.log");
  const exec = escapePlistString(process.execPath);
  const script = escapePlistString(scriptPath);
  const conf = escapePlistString(config.configPath);
  const wd = escapePlistString(projectRoot);
  const out = escapePlistString(stdoutPath);
  const err = escapePlistString(stderrPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapePlistString(config.scheduler.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${exec}</string>
      <string>${script}</string>
      <string>run</string>
      <string>--config</string>
      <string>${conf}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${wd}</string>
    <key>StandardOutPath</key>
    <string>${out}</string>
    <key>StandardErrorPath</key>
    <string>${err}</string>
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

async function runLaunchctl(args: string[], projectRoot: string) {
  return runCommand("launchctl", args, {
    cwd: projectRoot,
    timeoutMs: 30000,
  });
}

export async function scheduleNextLaunchd(
  config: AppConfig,
  nextRunMs: number,
  scriptPath: string,
  projectRoot: string,
) {
  const plistPath = config.scheduler.launchAgentPath;
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error("launchd scheduling requires a local macOS user session.");
  }

  await ensureDir(path.dirname(plistPath));
  await ensureDir(config.stateDir);
  await fsp.writeFile(
    plistPath,
    buildLaunchdPlist(config, nextRunMs, scriptPath, projectRoot),
    "utf8",
  );

  await runLaunchctl(["bootout", `gui/${uid}`, plistPath], projectRoot).catch(() => {});
  const bootstrap = await runLaunchctl(["bootstrap", `gui/${uid}`, plistPath], projectRoot);
  if (bootstrap.code !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`);
  }

  return plistPath;
}

export async function uninstallLaunchd(config: AppConfig, projectRoot: string) {
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error("launchd scheduling requires a local macOS user session.");
  }

  const plistPath = config.scheduler.launchAgentPath;
  await runLaunchctl(["bootout", `gui/${uid}`, plistPath], projectRoot).catch(() => {});
  if (await pathExists(plistPath)) {
    await fsp.unlink(plistPath);
  }

  return plistPath;
}
