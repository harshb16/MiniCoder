import type { Sandbox } from "../sandbox/docker";
import type { Trace } from "./trace";
import { type Checkpoint, RunError, type RunState } from "./types";

export class Checkpoints {
  baseline = "";
  constructor(
    private sandbox: Sandbox,
    private state: RunState,
    private trace: Trace,
  ) {}
  private async git(
    args: string[],
    signal?: AbortSignal,
    input?: string,
    raw = false,
  ): Promise<string> {
    const r = await this.sandbox.git(args, signal, input);
    if (r.exitCode !== 0 || r.timedOut || r.omittedBytes)
      throw new RunError("SANDBOX_ERROR", `Checkpoint Git failed: ${r.stderr.slice(-1000)}`);
    return raw ? r.stdout : r.stdout.trim();
  }
  async initialize(signal: AbortSignal): Promise<void> {
    await this.git(["add", "--force", "--all"], signal);
    const tree = await this.git(["write-tree"], signal);
    this.baseline = await this.git(["commit-tree", tree], signal, "MiniCoder input baseline\n");
    await this.git(["update-ref", "refs/heads/baseline", this.baseline], signal);
    await this.git(["symbolic-ref", "HEAD", "refs/heads/baseline"], signal);
    this.state.checkpoints.current = this.baseline;
    await this.snapshot("operational", signal);
  }
  async fingerprint(signal?: AbortSignal): Promise<string> {
    await this.git(["add", "--all"], signal);
    const tree = await this.git(["write-tree"], signal);
    this.state.checkpoints.currentTree = tree;
    return tree;
  }
  async snapshot(kind: Checkpoint["kind"], signal?: AbortSignal): Promise<Checkpoint> {
    const tree = await this.fingerprint(signal);
    const id = await this.git(
      ["commit-tree", tree],
      signal,
      `MiniCoder ${kind} turn ${this.state.turn}\n`,
    );
    await this.git(["update-ref", `refs/minicoder/${kind}`, id], signal);
    const point = { id, kind, turn: this.state.turn };
    this.state.checkpoints[kind] = point;
    this.state.checkpoints.current = id;
    await this.trace.event("checkpoint", point);
    return point;
  }
  async restore(point: Checkpoint, signal: AbortSignal): Promise<void> {
    await this.git(["read-tree", "--reset", "-u", point.id], signal);
    await this.git(["clean", "-fd"], signal);
    this.state.checkpoints.current = point.id;
    await this.trace.event("checkpoint_restore", point);
  }
  async diff(signal?: AbortSignal): Promise<string> {
    await this.fingerprint(signal);
    const patch = await this.git(
      ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", this.baseline, "--"],
      signal,
      undefined,
      true,
    );
    return patch;
  }
  async changed(signal?: AbortSignal): Promise<string[]> {
    await this.fingerprint(signal);
    const value = await this.git(
      ["diff", "--cached", "--name-only", "-z", this.baseline, "--"],
      signal,
      undefined,
      true,
    );
    return value.split("\0").filter(Boolean);
  }
  async validPatch(signal: AbortSignal): Promise<boolean> {
    const patch = await this.diff(signal);
    if (!patch) return true;
    // Check the reverse binary/text patch against the runtime-owned current index.
    const result = await this.sandbox.git(
      ["apply", "--cached", "--reverse", "--check", "--whitespace=nowarn", "-"],
      signal,
      `${patch}\n`,
    );
    return result.exitCode === 0 && !result.timedOut;
  }
}
