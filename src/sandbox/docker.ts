import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import { type CommandResult, RunError } from "../runtime/types";
import { processRun } from "./process";

export interface Sandbox {
  tool(tool: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  shell(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    network?: boolean,
  ): Promise<CommandResult>;
  git(args: string[], signal?: AbortSignal, input?: string): Promise<CommandResult>;
  cleanup(): Promise<void>;
}
export class DockerSandbox implements Sandbox {
  private workspace = `minicoder-ws-${randomUUID()}`;
  private control = `minicoder-control-${randomUUID()}`;
  private active = new Set<string>();
  private closing = false;
  constructor(private config: Config) {}
  private async docker(
    args: string[],
    options: Parameters<typeof processRun>[2] = {},
  ): Promise<CommandResult> {
    return processRun("docker", args, options);
  }
  private must(r: CommandResult): CommandResult {
    if (r.exitCode !== 0 || r.timedOut)
      throw new RunError("SANDBOX_ERROR", `Docker operation failed: ${r.stderr.slice(-2000)}`);
    return r;
  }
  async initialize(source: string, signal: AbortSignal): Promise<void> {
    this.must(await this.docker(["image", "inspect", this.config.image], { signal }));
    for (const name of [this.workspace, this.control])
      this.must(await this.docker(["volume", "create", name], { signal }));
    const name = `minicoder-copy-${randomUUID()}`;
    this.active.add(name);
    try {
      this.must(
        await this.docker(
          [
            "create",
            "--name",
            name,
            "--network",
            "none",
            "--user",
            "0:0",
            "--mount",
            `type=volume,src=${this.workspace},dst=/workspace`,
            this.config.image,
            "true",
          ],
          { signal },
        ),
      );
      this.must(
        await this.docker(["cp", `${source}/.`, `${name}:/workspace`], {
          signal,
          timeoutMs: 120000,
        }),
      );
    } finally {
      await this.docker(["rm", "-f", name]);
      this.active.delete(name);
    }
    this.must(
      await this.container(["chown", "-R", "1000:1000", "/workspace"], { root: true, signal }),
    );
    this.must(await this.git(["init"]));
    this.must(await this.git(["config", "user.name", "MiniCoder runtime"]));
    this.must(await this.git(["config", "user.email", "runtime@minicoder.local"]));
    this.must(await this.git(["config", "core.hooksPath", "/dev/null"]));
    // Runtime index excludes generated content even if the model changes .gitignore.
    this.must(
      await this.container(
        [
          "bash",
          "-c",
          "printf '%s\\n' node_modules/ .venv/ target/ dist/ build/ coverage/ __pycache__/ .git/ .agent/ .env .env.* > /control/repo/info/exclude; chmod -R go-rwx /control",
        ],
        { root: true, control: true, signal },
      ),
    );
  }
  private async container(
    command: string[],
    options: {
      root?: boolean;
      control?: boolean;
      network?: boolean;
      signal?: AbortSignal;
      input?: string;
      timeoutMs?: number;
      maxBytes?: number;
    } = {},
  ): Promise<CommandResult> {
    if (this.closing) throw new RunError("SANDBOX_ERROR", "Sandbox already closed");
    const name = `minicoder-exec-${randomUUID()}`;
    this.active.add(name);
    const args = [
      "run",
      "--rm",
      "-i",
      "--name",
      name,
      "--network",
      options.network ? "bridge" : "none",
      "--cpus",
      "2",
      "--memory",
      "1g",
      "--pids-limit",
      "128",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m,mode=1777",
      "--user",
      options.root ? "0:0" : "1000:1000",
      "--workdir",
      "/workspace",
      "--mount",
      `type=volume,src=${this.workspace},dst=/workspace`,
    ];
    // Only trusted Git/control operations receive the checkpoint volume.
    if (options.control) args.push("--mount", `type=volume,src=${this.control},dst=/control`);
    if (options.root) args.push("--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN");
    args.push(this.config.image, ...command);
    try {
      return await this.docker(args, {
        signal: options.signal,
        input: options.input,
        timeoutMs: options.timeoutMs ?? this.config.commandTimeoutMs + 10000,
        maxBytes: options.maxBytes,
      });
    } finally {
      await this.docker(["rm", "-f", name], { timeoutMs: 10000 });
      this.active.delete(name);
    }
  }
  async tool(tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const timeout =
      tool === "run_shell"
        ? Math.min(
            (args as { timeoutMs?: number }).timeoutMs ?? this.config.commandTimeoutMs,
            this.config.commandTimeoutMs,
          )
        : this.config.commandTimeoutMs;
    const payload = tool === "run_shell" ? { ...(args as object), timeoutMs: timeout } : args;
    const r = await this.container(["bun", "/opt/minicoder/src/tools/worker.ts"], {
      signal,
      network: this.config.network,
      input: JSON.stringify({ tool, arguments: payload }),
      timeoutMs: timeout + 10000,
      maxBytes: 3000000,
    });
    if (signal.aborted) signal.throwIfAborted();
    if (r.timedOut) throw new RunError("COMMAND_TIMEOUT", "Docker command exceeded timeout");
    this.must(r);
    let result: { ok: boolean; value: unknown; code?: string; message?: string };
    try {
      result = JSON.parse(r.stdout);
    } catch {
      throw new RunError("SANDBOX_ERROR", "Invalid sandbox worker result");
    }
    if (!result.ok)
      throw new RunError(
        result.code === "COMMAND_TIMEOUT" ? "COMMAND_TIMEOUT" : "TOOL_ERROR",
        result.message ?? "Tool failed",
      );
    return result.value;
  }
  async shell(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    network = this.config.network,
  ): Promise<CommandResult> {
    const r = await this.container(["bun", "/opt/minicoder/src/tools/worker.ts"], {
      signal,
      network,
      input: JSON.stringify({ tool: "run_shell", arguments: { command, cwd: ".", timeoutMs } }),
      timeoutMs: timeoutMs + 10000,
      maxBytes: 3000000,
    });
    if (signal.aborted) signal.throwIfAborted();
    if (r.timedOut) return { ...r, timedOut: true };
    this.must(r);
    const result = JSON.parse(r.stdout);
    if (!result.ok) throw new RunError("TOOL_ERROR", result.message);
    return result.value;
  }
  async git(args: string[], signal?: AbortSignal, input?: string): Promise<CommandResult> {
    const result = await this.container(
      [
        "git",
        "--no-replace-objects",
        "-c",
        "safe.directory=/workspace",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "--git-dir=/control/repo",
        "--work-tree=/workspace",
        ...args,
      ],
      { root: true, control: true, signal, input, maxBytes: 12000000, timeoutMs: 60000 },
    );
    if (args[0] === "read-tree" || args[0] === "checkout")
      this.must(
        await this.container(["chown", "-R", "1000:1000", "/workspace"], { root: true, signal }),
      );
    return result;
  }
  async cleanup(): Promise<void> {
    this.closing = true;
    for (const name of this.active) await this.docker(["rm", "-f", name], { timeoutMs: 10000 });
    this.active.clear();
    for (const name of [this.workspace, this.control])
      await this.docker(["volume", "rm", "-f", name], { timeoutMs: 10000 });
  }
}
