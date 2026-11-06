import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import type { AcceptanceCase } from "../runtime/acceptance";
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
  accept(
    tree: string,
    cases: AcceptanceCase[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<number | undefined>;
  cleanup(): Promise<void>;
}
export class DockerSandbox implements Sandbox {
  private workspace = `minicoder-ws-${randomUUID()}`;
  private control = `minicoder-control-${randomUUID()}`;
  private snapshots = new Set<string>();
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
  private async createResource(args: string[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // Wait for the daemon to finish creating the resource before cancellation can remove it.
    this.must(await this.docker(args, { timeoutMs: 10000 }));
    signal?.throwIfAborted();
  }
  async initialize(source: string, signal: AbortSignal): Promise<void> {
    this.must(await this.docker(["image", "inspect", this.config.image], { signal }));
    for (const name of [this.workspace, this.control])
      await this.createResource(["volume", "create", name], signal);
    const name = `minicoder-copy-${randomUUID()}`;
    this.active.add(name);
    try {
      await this.createResource(
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
        signal,
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
    this.must(await this.git(["init"], signal));
    this.must(await this.git(["config", "user.name", "MiniCoder runtime"], signal));
    this.must(await this.git(["config", "user.email", "runtime@minicoder.local"], signal));
    this.must(await this.git(["config", "core.hooksPath", "/dev/null"], signal));
    // Runtime index excludes generated content even if the model changes .gitignore.
    this.must(
      await this.container(
        [
          "bash",
          "-c",
          "printf '%s\\n' node_modules/ .venv/ target/ dist/ build/ coverage/ __pycache__/ .git/ .agent/ .env .env.* > /control/repo/info/exclude; chmod -R go-rwx /control",
        ],
        { root: true, control: "writable", signal },
      ),
    );
  }
  private async container(
    command: string[],
    options: {
      root?: boolean;
      control?: "readonly" | "writable";
      snapshot?: { volume: string; readonly: boolean };
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
      "create",
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
      options.snapshot
        ? `type=volume,src=${options.snapshot.volume},dst=/workspace,volume-nocopy${options.snapshot.readonly ? ",readonly" : ""}`
        : `type=volume,src=${this.workspace},dst=/workspace`,
    ];
    // Only trusted Git/control operations receive the checkpoint volume.
    if (options.control)
      args.push(
        "--mount",
        `type=volume,src=${this.control},dst=/control${options.control === "readonly" ? ",readonly" : ""}`,
      );
    if (options.root) args.push("--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN");
    args.push(this.config.image, ...command);
    try {
      await this.createResource(args, options.signal);
      return await this.docker(["start", "-ai", name], {
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
      { root: true, control: "writable", signal, input, maxBytes: 12000000, timeoutMs: 60000 },
    );
    if (args[0] === "read-tree" || args[0] === "checkout")
      this.must(
        await this.container(["chown", "-R", "1000:1000", "/workspace"], { root: true, signal }),
      );
    return result;
  }
  async accept(
    tree: string,
    cases: AcceptanceCase[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new RunError("SANDBOX_ERROR", "Invalid Git tree");
    const volume = `minicoder-snapshot-${randomUUID()}`;
    this.snapshots.add(volume);
    try {
      await this.createResource(["volume", "create", volume], signal);
      // A separate bare repository reads only runtime-owned objects. Override candidate
      // archive and checkout attributes so the snapshot contains the stored Git blobs.
      this.must(
        await this.container(
          [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            String.raw`umask 022
git init -q --bare /tmp/acceptance-git
printf '%s\n' '* -export-ignore -export-subst -text -eol -crlf -ident -filter -working-tree-encoding' > /tmp/acceptance-git/info/attributes
export GIT_OBJECT_DIRECTORY=/control/repo/objects GIT_ATTR_NOSYSTEM=1
git --git-dir=/tmp/acceptance-git ls-tree -r --format='%(objectmode)' "$1" |
  awk '$0 != "100644" && $0 != "100755" { bad = 1 } END { exit bad }'
git --git-dir=/tmp/acceptance-git -c core.attributesFile=/dev/null archive --format=tar "$1" |
  tar -x --no-same-owner --no-same-permissions`,
            "minicoder-snapshot",
            tree,
          ],
          { root: true, control: "readonly", snapshot: { volume, readonly: false }, signal },
        ),
      );
      for (const [index, test] of cases.entries()) {
        signal.throwIfAborted();
        const result = await this.container(test.argv, {
          snapshot: { volume, readonly: true },
          input: test.stdin,
          signal,
          timeoutMs,
        });
        signal.throwIfAborted();
        // Expected values and the pass/fail decision stay in the host runtime.
        if (
          result.exitCode !== 0 ||
          result.timedOut ||
          result.omittedBytes ||
          result.stdout !== test.stdout
        )
          return index + 1;
      }
    } finally {
      const removed = await this.docker(["volume", "rm", "-f", volume], { timeoutMs: 10000 });
      if (removed.exitCode === 0) this.snapshots.delete(volume);
    }
  }
  async cleanup(): Promise<void> {
    this.closing = true;
    const failures: string[] = [];
    const remove = async (args: string[]) => {
      const r = await this.docker(args, { timeoutMs: 10000 });
      if (r.exitCode !== 0 && !/No such|not found|does not exist/i.test(r.stderr))
        failures.push(r.stderr.slice(-1000));
    };
    for (const name of this.active) await remove(["rm", "-f", name]);
    this.active.clear();
    for (const name of [this.workspace, this.control, ...this.snapshots])
      await remove(["volume", "rm", "-f", name]);
    this.snapshots.clear();
    if (failures.length)
      throw new RunError("SANDBOX_ERROR", `Sandbox cleanup failed: ${failures.join("; ")}`);
  }
}
