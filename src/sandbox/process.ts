import { spawn } from "node:child_process";
import type { CommandResult } from "../runtime/types";

// Only trusted runtime binaries are spawned on the host. Agent shell text is never passed here.
export function processRun(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> {
  const start = Date.now();
  const max = options.maxBytes ?? 1048576;
  return new Promise((resolve, reject) => {
    let stdout: Buffer = Buffer.alloc(0),
      stderr: Buffer = Buffer.alloc(0);
    let omittedBytes = 0,
      timedOut = false;
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const collect = (old: Buffer, chunk: Buffer): Buffer => {
      const combined = Buffer.concat([old, chunk]);
      if (combined.length <= max) return combined;
      omittedBytes += combined.length - max;
      const half = Math.floor(max / 2);
      return Buffer.concat([
        combined.subarray(0, half),
        combined.subarray(combined.length - (max - half)),
      ]);
    };
    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    const kill = () => {
      try {
        if (child.pid)
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? 60000);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code ?? 137,
        timedOut,
        durationMs: Date.now() - start,
        omittedBytes,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    if (options.signal?.aborted) kill();
  });
}
