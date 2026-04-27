import { spawn } from "node:child_process";
import process from "node:process";

const MAX_STDIO_BYTES = 5_000_000;

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RunOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 180000;
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...(options.env ?? {}) };

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedForSize = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const appendLimited = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      const next = target === "stdout" ? stdout + text : stderr + text;
      if (next.length > MAX_STDIO_BYTES) {
        killedForSize = true;
        child.kill("SIGTERM");
        return;
      }
      if (target === "stdout") {
        stdout = next;
      } else {
        stderr = next;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      appendLimited("stdout", chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      appendLimited("stderr", chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Could not start "${command}": not found on PATH or not executable. Install the CLI or set an absolute path in config (e.g. codex.command). ${error.message}`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedForSize) {
        resolve({
          code: code ?? 1,
          stdout,
          stderr: `${stderr}\n[ai-limit-timer] child output exceeded ${MAX_STDIO_BYTES} bytes; process was terminated.`,
          timedOut: timedOut || killedForSize,
        });
        return;
      }
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}
