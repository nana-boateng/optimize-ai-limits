function normalizeResetWindow(window) {
  if (!window || !Number.isFinite(window.resets_at)) {
    return null;
  }

  return {
    usedPercent: Number.isFinite(window.used_percent) ? window.used_percent : null,
    windowMinutes: Number.isFinite(window.window_minutes) ? window.window_minutes : null,
    resetsAtMs: window.resets_at * 1000,
  };
}

function buildWindowLabel(kind, minutes) {
  if (kind === "secondary") {
    return "weekly";
  }

  if (minutes === 300) {
    return "5h";
  }

  if (Number.isFinite(minutes)) {
    return `${minutes}m`;
  }

  return kind;
}

function parseCodexRateLimitLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const payload = parsed?.payload;
  if (payload?.type !== "token_count" || !payload?.rate_limits) {
    return null;
  }

  const primary = normalizeResetWindow(payload.rate_limits.primary);
  const secondary = normalizeResetWindow(payload.rate_limits.secondary);
  if (!primary && !secondary) {
    return null;
  }

  return {
    provider: "codex",
    source: "session-log",
    checkedAt: parsed.timestamp ?? new Date().toISOString(),
    planType: payload.rate_limits.plan_type ?? null,
    primary: primary
      ? {
          kind: "primary",
          label: buildWindowLabel("primary", primary.windowMinutes),
          ...primary,
        }
      : null,
    secondary: secondary
      ? {
          kind: "secondary",
          label: buildWindowLabel("secondary", secondary.windowMinutes),
          ...secondary,
        }
      : null,
  };
}

export function parseCodexRateLimitsJsonl(text, filePath = null) {
  const lines = String(text ?? "").trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseCodexRateLimitLine(lines[index]);
    if (parsed) {
      return filePath ? { ...parsed, rawPath: filePath } : parsed;
    }
  }

  return null;
}

export function parseClaudeStreamJson(stdout, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const lines = String(stdout ?? "").trim().split("\n");

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed?.type !== "rate_limit_event" || !parsed?.rate_limit_info) {
      continue;
    }

    const info = parsed.rate_limit_info;
    const primaryResetsAt = Number.isFinite(info.resetsAt) ? info.resetsAt : null;
    const secondaryResetsAt = Number.isFinite(info.overageResetsAt) ? info.overageResetsAt : null;

    if (!primaryResetsAt && !secondaryResetsAt) {
      continue;
    }

    return {
      provider: "claude",
      source: "stream-json",
      checkedAt: now.toISOString(),
      primary: primaryResetsAt
        ? {
            kind: "primary",
            label: "5h",
            windowMinutes: 300,
            usedPercent: null,
            resetsAtMs: primaryResetsAt * 1000,
          }
        : null,
      secondary: secondaryResetsAt
        ? {
            kind: "secondary",
            label: "weekly",
            windowMinutes: 10080,
            usedPercent: null,
            resetsAtMs: secondaryResetsAt * 1000,
          }
        : null,
    };
  }

  return null;
}
