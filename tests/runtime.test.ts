import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/orchestrator";
import { loadConfig } from "../src/config";
import type { ModelAdapter } from "../src/models/adapters";
import type { Action } from "../src/models/schema";
import { Checkpoints } from "../src/runtime/checkpoints";
import { Hooks } from "../src/runtime/hooks";
import { RecoveryPolicy } from "../src/runtime/recovery";
import { Trace } from "../src/runtime/trace";
import type { CommandResult, Verification } from "../src/runtime/types";
import { RunError } from "../src/runtime/types";
import { detectVerification, Verifier } from "../src/runtime/verifier";
import type { Sandbox } from "../src/sandbox/docker";
import { processRun } from "../src/sandbox/process";
import { state } from "./helpers";

const ok = (stdout = ""): CommandResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  omittedBytes: 0,
});
class FakeSandbox implements Sandbox {
  calls: string[][] = [];
  closed = false;
  testPass = true;
  violations: string[] = [];
  async initialize(): Promise<void> {}
  async tool(name: string): Promise<unknown> {
    return name === "audit" ? { violations: this.violations } : { ok: true };
  }
  async shell(): Promise<CommandResult> {
    return this.testPass ? ok() : { ...ok(), exitCode: 1, stderr: "assertion failed" };
  }
  async git(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    return ok(["commit-tree", "write-tree"].includes(args[0] ?? "") ? "a".repeat(40) : "");
  }
  async cleanup(): Promise<void> {
    this.closed = true;
  }
}
const verification = (passed: boolean, fingerprint = "new"): Verification => ({
  passed,
  fingerprint,
  commands: [],
  errors: passed ? [] : ["test failed"],
  patchValid: true,
});

test("independent verifier executes frozen commands, detects failure and refuses absent checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-verify-"));
  const trace = new Trace(dir);
  await trace.init({});
  const sandbox = new FakeSandbox();
  const points = new Checkpoints(sandbox, state(), trace);
  const signal = new AbortController().signal;
  try {
    const verifier = new Verifier(
      sandbox,
      points,
      { commands: ["bun test"], source: "configured" },
      trace,
      100,
    );
    expect((await verifier.verify(signal)).passed).toBe(true);
    sandbox.testPass = false;
    const result = await verifier.verify(signal);
    expect(result.passed).toBe(false);
    expect(result.commands[0]?.result.stderr).toContain("assertion failed");
    sandbox.testPass = true;
    sandbox.violations = ["escape"];
    expect((await verifier.verify(signal)).passed).toBe(false);
    sandbox.violations = [];
    expect(
      (
        await new Verifier(sandbox, points, { commands: [], source: "none" }, trace, 100).verify(
          signal,
        )
      ).passed,
    ).toBe(false);
    const original = ["bun test"];
    const configured = { verification: original, bootstrap: [] };
    const detected = await detectVerification(dir, configured);
    original.push("cheat");
    expect(detected.commands).toEqual(["bun test"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("checkpoints track operational, validated and current; restore is traced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-cp-"));
  try {
    const trace = new Trace(dir);
    await trace.init({});
    const s = state();
    const sandbox = new FakeSandbox();
    const cp = new Checkpoints(sandbox, s, trace);
    const signal = new AbortController().signal;
    await cp.initialize(signal);
    expect(s.checkpoints.operational?.kind).toBe("operational");
    const validated = await cp.snapshot("validated", signal);
    expect(s.checkpoints.validated?.id).toBe(validated.id);
    await cp.restore(validated, signal);
    expect(s.checkpoints.current).toBe(validated.id);
    expect(sandbox.calls.some((x) => x[0] === "read-tree")).toBe(true);
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toContain("checkpoint_restore");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("regression recovery allows two repairs, restores only validated states, resets on pass", () => {
  const policy = new RecoveryPolicy(2);
  const point = { id: "known-good", kind: "validated" as const, turn: 1 };
  for (let i = 0; i < 5; i++)
    expect(policy.observe(verification(false), undefined)).toBe("continue");
  expect(policy.observe(verification(false), point)).toBe("continue");
  expect(policy.observe(verification(false), point)).toBe("continue");
  expect(policy.observe(verification(false), point)).toBe("restore");
  expect(policy.observe(verification(true), point)).toBe("continue");
  expect(policy.observe(verification(false), point)).toBe("continue");
  expect(policy.history.length).toBeGreaterThan(0);
});
async function inputRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "mini-run-"));
  const repo = join(root, "repo");
  await cp(join(import.meta.dir, "../fixtures/tiny"), repo, { recursive: true });
  const init = await processRun("git", ["init", repo]);
  if (init.exitCode !== 0) throw new Error(init.stderr);
  return { root, repo };
}
test("completion cannot bypass verifier; failed verification returns to agent and exhausts budget", async () => {
  const { root, repo } = await inputRepo();
  const sandbox = new FakeSandbox();
  sandbox.testPass = false;
  const adapter = completionModel("done");
  try {
    const result = await runAgent({
      repo,
      task: "fix",
      config: loadConfig({}, { maxTurns: 2, fallback: false }),
      artifactRoot: join(root, "runs"),
      sandbox,
      adapters: [adapter],
    });
    expect(result.status).toBe("BUDGET_EXHAUSTED");
    expect(result.verification?.passed).toBe(false);
    expect(result.turn).toBe(2);
    expect(sandbox.closed).toBe(true);
    const events = await readFile(join(result.artifacts, "events.jsonl"), "utf8");
    expect(events).toContain("VERIFICATION_FAILED");
    expect(events).toContain("SessionEnd");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("cancellation finalizes trace, report, patch and sandbox cleanup", async () => {
  const { root, repo } = await inputRepo();
  const sandbox = new FakeSandbox();
  const ac = new AbortController();
  const hooks = new Hooks();
  const adapter: ModelAdapter = {
    key: "gemini",
    id: "test",
    contextLimit: 32000,
    generate: async () => {
      ac.abort();
      throw new RunError("CANCELLED", "cancel");
    },
  };
  let stopped = false;
  hooks.on("Stop", () => {
    stopped = true;
  });
  try {
    const result = await runAgent({
      repo,
      task: "fix",
      config: loadConfig({}, { fallback: false }),
      artifactRoot: join(root, "runs"),
      signal: ac.signal,
      sandbox,
      adapters: [adapter],
      hooks,
    });
    expect(result.status).toBe("CANCELLED");
    expect(stopped).toBe(true);
    expect(sandbox.closed).toBe(true);
    expect(JSON.parse(await readFile(join(result.artifacts, "state.json"), "utf8")).status).toBe(
      "CANCELLED",
    );
    expect(JSON.parse(await readFile(join(result.artifacts, "report.json"), "utf8")).status).toBe(
      "CANCELLED",
    );
    expect(await readFile(join(result.artifacts, "final.patch"), "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("artifacts cannot be placed inside the original repository", async () => {
  const { root, repo } = await inputRepo();
  try {
    await expect(
      runAgent({ repo, task: "fix", config: loadConfig({}), artifactRoot: join(repo, ".agent") }),
    ).rejects.toThrow("outside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifier pass is the only successful loop exit and metrics are persisted", async () => {
  const { root, repo } = await inputRepo();
  const sandbox = new FakeSandbox();
  const adapter = completionModel("done");
  try {
    const result = await runAgent({
      repo,
      task: "fix",
      config: loadConfig({}, { fallback: false }),
      artifactRoot: join(root, "runs"),
      sandbox,
      adapters: [adapter],
    });
    expect(result.status).toBe("SUCCESS");
    expect(result.verification?.passed).toBe(true);
    expect(result.checkpoints.validated?.kind).toBe("validated");
    expect(result.checkpoints.currentTree).toBe("a".repeat(40));
    const report = JSON.parse(await readFile(join(result.artifacts, "report.json"), "utf8"));
    expect(report.modelCalls).toBe(2);
    expect(report.inputTokens).toBe(20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("completion with an unfinished plan cannot start final verification", async () => {
  const { root, repo } = await inputRepo();
  const sandbox = new FakeSandbox();
  const adapter = completionModel("pending");
  try {
    const result = await runAgent({
      repo,
      task: "fix",
      config: loadConfig({}, { fallback: false, maxTurns: 2 }),
      artifactRoot: join(root, "runs"),
      sandbox,
      adapters: [adapter],
    });
    expect(result.status).toBe("BUDGET_EXHAUSTED");
    const events = (await readFile(join(result.artifacts, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(events.filter((x) => x.type === "verification").length).toBe(1);
    expect(events.some((x) => x.type === "tool_result" && x.data.failed)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function completionModel(status: "pending" | "done"): ModelAdapter {
  let planned = false;
  return {
    key: "gemini",
    id: "test",
    contextLimit: 32000,
    generate: async () => {
      const action: Action = planned
        ? { tool: "request_completion", arguments: { summary: "I am done" } }
        : {
            tool: "update_plan",
            arguments: { plan: [{ id: "fix", content: "Fix arithmetic", status }] },
          };
      planned = true;
      return { action, inputTokens: 10, outputTokens: 5 };
    },
  };
}

test("diff preserves meaningful trailing whitespace and NUL-delimited filenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-diff-"));
  try {
    const trace = new Trace(dir);
    await trace.init({});
    const sandbox = new FakeSandbox();
    const patch =
      "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-old\n+new\n \n";
    sandbox.git = async (args) =>
      args[0] === "diff"
        ? ok(args.includes("--name-only") ? " file \0" : patch)
        : ok("a".repeat(40));
    const cp = new Checkpoints(sandbox, state(), trace);
    cp.baseline = "a".repeat(40);
    expect(await cp.diff()).toBe(patch);
    expect(await cp.changed()).toEqual([" file "]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
