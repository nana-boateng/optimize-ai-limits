function normalizeResetWindow(window: { resets_at?: unknown; used_percent?: unknown; window_minutes?: unknown } | null) {
  if (!window || !Number.isFinite(window.resets_at)) {
    return null;
  }

  return {
    usedPercent: Number.isFinite(window.used_percent as number) ? (window.used_percent as number) : null,
    windowMinutes: Number.isFinite(window.window_minutes as number) ? (window.window_minutes as number) : null,
    resetsAtMs: (window.resets_at as number) * 1000,
  };
}

function buildWindowLabel(kind: "primary" | "secondary", minutes: number | null | undefined): string {
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

function parseCodexRateLimitLine(line: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }

  const rec = parsed as { payload?: { type?: string; rate_limits?: unknown; plan_type?: unknown }; timestamp?: string };
  const payload = rec?.payload;
  if (payload?.type !== "token_count" || !payload?.rate_limits) {
    return null;
  }

  const rateLimits = payload.rate_limits as {
    plan_type?: unknown;
    primary?: { resets_at?: number; used_percent?: number; window_minutes?: number } | null;
    secondary?: { resets_at?: number; used_percent?: number; window_minutes?: number } | null;
  };
  const primary = normalizeResetWindow(rateLimits.primary ?? null);
  const secondary = normalizeResetWindow(rateLimits.secondary ?? null);
  if (!primary && !secondary) {
    return null;
  }

  return {
    provider: "codex" as const,
    source: "session-log" as const,
    checkedAt: rec.timestamp ?? new Date().toISOString(),
    planType: (rateLimits.plan_type as string) ?? null,
    primary: primary
      ? {
          kind: "primary" as const,
          label: buildWindowLabel("primary", primary.windowMinutes),
          ...primary,
        }
      : null,
    secondary: secondary
      ? {
          kind: "secondary" as const,
          label: buildWindowLabel("secondary", secondary.windowMinutes),
          ...secondary,
        }
      : null,
  };
}

export function parseCodexRateLimitsJsonl(text: string | null | undefined, filePath: string | null = null) {
  const lines = String(text ?? "")
    .trim()
    .split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line == null) {
      break;
    }
    const parsed = parseCodexRateLimitLine(line);
    if (parsed) {
      return filePath ? { ...parsed, rawPath: filePath } : parsed;
    }
  }

  return null;
}

export function parseClaudeStreamJson(
  stdout: string | null | undefined,
  options: { now?: number | Date } = {},
) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const lines = String(stdout ?? "")
    .trim()
    .split("\n");

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    const rec = parsed as { type?: string; rate_limit_info?: { resetsAt?: number; overageResetsAt?: number } };
    if (rec?.type !== "rate_limit_event" || !rec?.rate_limit_info) {
      continue;
    }

    const info = rec.rate_limit_info;
    const primaryResetsAt = Number.isFinite(info.resetsAt) ? info.resetsAt : null;
    const secondaryResetsAt = Number.isFinite(info.overageResetsAt) ? info.overageResetsAt : null;

    if (!primaryResetsAt && !secondaryResetsAt) {
      continue;
    }

    return {
      provider: "claude" as const,
      source: "stream-json" as const,
      checkedAt: now.toISOString(),
      primary: primaryResetsAt
        ? {
            kind: "primary" as const,
            label: "5h" as const,
            windowMinutes: 300,
            usedPercent: null,
            resetsAtMs: (primaryResetsAt as number) * 1000,
          }
        : null,
      secondary: secondaryResetsAt
        ? {
            kind: "secondary" as const,
            label: "weekly" as const,
            windowMinutes: 10080,
            usedPercent: null,
            resetsAtMs: (secondaryResetsAt as number) * 1000,
          }
        : null,
    };
  }

  return null;
}
