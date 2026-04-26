import path from "node:path";

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Reject null bytes, newlines, and obvious shell metacharacters in the executable
 * path or bare name (argv0). Spawns are non-shell; this blocks accidental "sh -c" style values.
 */
export function assertExecutablePathOrName(name: string, label: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (CONTROL.test(name) || /[\n\r;|&$`]/.test(name)) {
    throw new Error(`${label} contains invalid or unsafe characters.`);
  }
}

export function assertConfigPathString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.includes("\u0000")) {
    throw new Error(`${label} contains an invalid null byte.`);
  }
}

/** Escape text embedded in a macOS property list. */
export function escapePlistString(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * For systemd / descriptive strings; avoids breaking unit files or logs with control bytes.
 */
export function scrubOneLineText(value: string, label: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must not contain newline characters.`);
  }
  if (value.includes("\u0000")) {
    throw new Error(`${label} contains an invalid null byte.`);
  }
  return value;
}

/**
 * Resolve a path and ensure the result is absolute and not empty.
 */
export function assertAbsoluteResolved(resolved: string, label: string): void {
  if (!path.isAbsolute(resolved)) {
    throw new Error(`${label} must resolve to an absolute path, got: ${resolved}`);
  }
  if (resolved.includes("\u0000")) {
    throw new Error(`${label} contains an invalid null byte.`);
  }
}
