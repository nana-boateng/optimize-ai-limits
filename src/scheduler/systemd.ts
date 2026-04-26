import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { AppConfig } from "../config.js";
import { scrubOneLineText } from "../hardening.js";
import { runCommand } from "../run-child.js";
import { ensureDir, pathExists } from "./shared.js";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local-time calendar string for systemd .timer `OnCalendar=` (one-shot at next run). */
export function formatOnCalendarLocal(nextRunMs: number) {
  const d = new Date(nextRunMs);
  const wd = WEEKDAY[d.getDay()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${wd} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function unitName(config: AppConfig) {
  return `${scrubOneLineText(config.scheduler.label, "scheduler.label")}.service`;
}

function timerName(config: AppConfig) {
  return `${scrubOneLineText(config.scheduler.label, "scheduler.label")}.timer`;
}

function escapePathForSystemdFile(value: string) {
  return value.replace(/\\/g, "\\\\");
}

function buildServiceUnit(config: AppConfig, scriptPath: string, projectRoot: string) {
  const stdout = path.join(config.stateDir, "systemd.stdout.log");
  const stderr = path.join(config.stateDir, "systemd.stderr.log");
  return `[Unit]
Description=AI Limit Timer (oneshot)

[Service]
Type=oneshot
WorkingDirectory=${escapePathForSystemdFile(path.resolve(projectRoot))}
ExecStart=${escapePathForSystemdFile(process.execPath)} ${escapePathForSystemdFile(scriptPath)} run --config ${escapePathForSystemdFile(path.resolve(config.configPath))}
StandardOutput=append:${escapePathForSystemdFile(path.resolve(stdout))}
StandardError=append:${escapePathForSystemdFile(path.resolve(stderr))}
Environment=AI_LIMIT_TIMER_FROM_SYSTEMD=1
`.trimStart();
}

function buildTimerUnit(config: AppConfig, nextRunMs: number) {
  const onCal = formatOnCalendarLocal(nextRunMs);
  const unit = unitName(config);
  return `[Unit]
Description=AI Limit Timer (next run)

[Timer]
OnCalendar=${onCal}
Unit=${unit}
Persistent=true

[Install]
WantedBy=default.target
`.trimStart();
}

export async function scheduleNextSystemd(
  config: AppConfig,
  nextRunMs: number,
  scriptPath: string,
  projectRoot: string,
) {
  if (process.platform !== "linux") {
    throw new Error("systemd scheduling is only supported on Linux (with systemd).");
  }

  const unitDir = config.scheduler.userUnitDir;
  await ensureDir(unitDir);

  const servicePath = path.join(unitDir, unitName(config));
  const timerPath = path.join(unitDir, timerName(config));

  await fsp.writeFile(servicePath, buildServiceUnit(config, scriptPath, projectRoot), { mode: 0o600, encoding: "utf8" });
  await fsp.writeFile(timerPath, buildTimerUnit(config, nextRunMs), { mode: 0o600, encoding: "utf8" });

  const t = timerName(config);
  await runCommand("systemctl", ["--user", "stop", t], { cwd: projectRoot, timeoutMs: 30_000 }).catch(() => {});

  const reload = await runCommand("systemctl", ["--user", "daemon-reload"], { cwd: projectRoot, timeoutMs: 30_000 });
  if (reload.code !== 0) {
    throw new Error(
      `systemd user daemon-reload failed (is loginctl user lingering enabled, and is DBUS available?): ${reload.stderr || reload.stdout}`,
    );
  }

  const enable = await runCommand("systemctl", ["--user", "enable", "--now", t], { cwd: projectRoot, timeoutMs: 30_000 });
  if (enable.code !== 0) {
    throw new Error(`systemd user enable --now ${t} failed: ${enable.stderr || enable.stdout}`);
  }

  return { servicePath, timerPath };
}

export async function uninstallSystemd(config: AppConfig, projectRoot: string) {
  const t = timerName(config);
  const u = unitName(config);
  const unitDir = config.scheduler.userUnitDir;

  await runCommand("systemctl", ["--user", "disable", "--now", t], { cwd: projectRoot, timeoutMs: 30_000 }).catch(() => {});

  const servicePath = path.join(unitDir, u);
  const timerPath = path.join(unitDir, t);
  if (await pathExists(servicePath)) {
    await fsp.unlink(servicePath);
  }
  if (await pathExists(timerPath)) {
    await fsp.unlink(timerPath);
  }
  await runCommand("systemctl", ["--user", "daemon-reload"], { cwd: projectRoot, timeoutMs: 30_000 }).catch(() => {});

  return { servicePath, timerPath };
}
