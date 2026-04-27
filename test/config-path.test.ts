import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, resolveConfigPathFromEnv } from "../src/config.js";
import { runCommand } from "../src/run-child.js";

test("resolveConfigPathFromEnv: CLI wins over env and default", () => {
  const prev = process.env.AI_LIMIT_TIMER_CONFIG;
  process.env.AI_LIMIT_TIMER_CONFIG = "/env/config.json";
  try {
    assert.equal(resolveConfigPathFromEnv("/cli/config.json"), "/cli/config.json");
  } finally {
    if (prev === undefined) {
      delete process.env.AI_LIMIT_TIMER_CONFIG;
    } else {
      process.env.AI_LIMIT_TIMER_CONFIG = prev;
    }
  }
});

test("resolveConfigPathFromEnv: env when CLI null", () => {
  const prev = process.env.AI_LIMIT_TIMER_CONFIG;
  process.env.AI_LIMIT_TIMER_CONFIG = "  /data/app.json  ";
  try {
    assert.equal(resolveConfigPathFromEnv(null), "/data/app.json");
  } finally {
    if (prev === undefined) {
      delete process.env.AI_LIMIT_TIMER_CONFIG;
    } else {
      process.env.AI_LIMIT_TIMER_CONFIG = prev;
    }
  }
});

test("runCommand: ENOENT produces an actionable error", async () => {
  await assert.rejects(
    async () => {
      await runCommand("ailimit-timer-missing-exe-42", [], { timeoutMs: 2000 });
    },
    (err) => {
      const e = err as Error;
      return /not found on PATH|not executable/.test(e.message) && e.message.includes("ailimit-timer-missing-exe-42");
    },
  );
});

test("loadConfig: reads AI_LIMIT_TIMER_CONFIG when set (absolute path)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ailimit-"));
  const cfg = path.join(dir, "c.json");
  await fsp.writeFile(cfg, "{}", "utf8");
  const prev = process.env.AI_LIMIT_TIMER_CONFIG;
  process.env.AI_LIMIT_TIMER_CONFIG = cfg;
  try {
    const c = await loadConfig(null);
    assert.equal(path.normalize(c.configPath), path.normalize(path.resolve(cfg)));
  } finally {
    if (prev === undefined) {
      delete process.env.AI_LIMIT_TIMER_CONFIG;
    } else {
      process.env.AI_LIMIT_TIMER_CONFIG = prev;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
