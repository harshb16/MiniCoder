import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/agent/context";
import { loadConfig } from "../src/config";
import { type ModelAdapter, ModelChain, ProviderError } from "../src/models/adapters";
import { Budgets, LoopDetector } from "../src/runtime/budgets";
import { Hooks } from "../src/runtime/hooks";
import { boundOutput, Trace } from "../src/runtime/trace";
import { PlanSchema, replacePlan, transition } from "../src/runtime/types";
import { processRun } from "../src/sandbox/process";
import { normalizePath, shellPolicy, workspacePath } from "../src/tools/policy";
import { state } from "./helpers";

describe("core invariants", () => {
  test("plan replacement is atomic and validates unique IDs and status", () => {
    const s = state();
    replacePlan(s, [{ id: "a", content: "inspect", status: "pending" }]);
    replacePlan(s, [{ id: "b", content: "fix", status: "in_progress" }]);
    expect(s.plan.map((x) => x.id)).toEqual(["b"]);
    expect(() => replacePlan(s, [{ id: "bad", content: "", status: "done" }])).toThrow();
    expect(s.plan[0]?.id).toBe("b");
    expect(
      PlanSchema.safeParse([
        { id: "x", content: "a", status: "pending" },
        { id: "x", content: "b", status: "pending" },
      ]).success,
    ).toBe(false);
  });
  test("success requires verifier authorization and terminal is immutable", () => {
    const s = state();
    transition(s, "RUNNING");
    expect(() => transition(s, "SUCCESS")).toThrow();
    transition(s, "VERIFYING");
    expect(() => transition(s, "SUCCESS")).toThrow();
    transition(s, "SUCCESS", true);
    expect(() => transition(s, "FAILED")).toThrow();
  });
  test("path normalization rejects traversal and protected paths", () => {
    expect(normalizePath("/workspace", "src/a.ts")).toBe("/workspace/src/a.ts");
    for (const path of ["../a", "src/../../a", "/etc/passwd", ".git/config", ".env", "a\\b"])
      expect(() => normalizePath("/workspace", path)).toThrow();
  });
  test("symlink restriction and missing file behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mini-path-"));
    try {
      await mkdir(join(dir, "src"));
      await symlink("/tmp", join(dir, "link"));
      expect(await workspacePath(dir, "src/new.ts", true)).toBe(
        join(await realpath(dir), "src/new.ts"),
      );
      await expect(workspacePath(dir, "link/file", true)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("shell policy blocks destructive commands", () => {
    expect(() => shellPolicy("rm -rf /")).toThrow();
    expect(() => shellPolicy("git push")).toThrow();
    shellPolicy("bun test");
  });
  test("process timeout and bounded streams", async () => {
    const r = await processRun(process.execPath, ["-e", "setTimeout(()=>{},20000)"], {
      timeoutMs: 30,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    const big = await processRun(process.execPath, ["-e", 'console.log("x".repeat(10000))'], {
      maxBytes: 1000,
    });
    expect(big.stdout.length).toBeLessThanOrEqual(1000);
    expect(big.omittedBytes).toBeGreaterThan(0);
  });
  test("output truncation keeps beginning and error tail", () => {
    const r = boundOutput(`START${"x".repeat(30000)}ERROR`, 1000);
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.text).toContain("START");
    expect(r.text).toContain("ERROR");
    expect(r.omitted).toBeGreaterThan(0);
  });
  test("budgets check turns, wall time, tokens and cancellation", () => {
    const s = state(),
      b = new Budgets(s);
    s.turn = 3;
    expect(() => b.check(new AbortController().signal, true)).toThrow();
    s.turn = 0;
    s.usage.inputTokens = 10000;
    expect(() => b.check(new AbortController().signal)).toThrow();
    s.usage.inputTokens = 0;
    const ac = new AbortController();
    ac.abort();
    expect(() => b.check(ac.signal)).toThrow();
    expect(() =>
      new Budgets(s, () => Date.parse(s.startedAt) + 10001).check(new AbortController().signal),
    ).toThrow();
  });
  test("loop detection allows progress and rejects repetition", () => {
    const d = new LoopDetector();
    d.observe("read", {}, "1");
    d.observe("read", {}, "2");
    d.observe("read", {}, "3");
    d.observe("read", {}, "3");
    expect(() => d.observe("read", {}, "3")).toThrow();
  });
  test("trace is JSONL and redacts keys atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mini-trace-"));
    try {
      const t = new Trace(dir, ["secret-value"]);
      await t.init({ id: "x" });
      await t.event("tool", { value: "secret-value" });
      await t.save(state());
      expect(
        JSON.parse((await readFile(join(dir, "events.jsonl"), "utf8")).trim()).data.value,
      ).toBe("<REDACTED>");
      expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).status).toBe("CREATED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("hooks run sequentially and unsubscribe", async () => {
    const h = new Hooks(),
      calls: number[] = [];
    const off = h.on("PreToolUse", () => {
      calls.push(1);
    });
    h.on("PreToolUse", () => {
      calls.push(2);
    });
    await h.emit("PreToolUse");
    off();
    await h.emit("PreToolUse");
    expect(calls).toEqual([1, 2, 2]);
  });
  test("compaction preserves task and structured plan", async () => {
    const s = state();
    s.task = "unique task";
    s.plan = [{ id: "x", content: "inspect", status: "pending" }];
    const h = new Hooks();
    let compacted = false;
    h.on("PreCompact", () => {
      compacted = true;
    });
    const c = new ContextManager(s, h);
    for (let i = 0; i < 20; i++)
      c.add({ tool: "read", arguments: { path: "src/a" }, output: "x".repeat(3000) });
    const text = await c.build(12000, 100);
    expect(compacted).toBe(true);
    expect(text).toContain("unique task");
    expect(text).toContain("inspect");
    expect(s.context.compactions).toBe(1);
    expect(s.context.summary).toContain("src/a");
  });
  test("fixed default ordering and free-only guard", () => {
    expect(loadConfig({}).models.map((x) => x.id)).toEqual([
      "gemini-3.8-flash",
      "qwen3.7-flash",
      "deepseek-v4-flash-0731",
    ]);
    expect(() => loadConfig({ MINICODER_FREE_ONLY: "false" })).toThrow();
    expect(loadConfig({}, { model: "qwen" }).fallback).toBe(false);
  });
  test("FreeLLMAPI IDs and context limits are configurable for pinned models", () => {
    const config = loadConfig(
      {
        FREELLMAPI_QWEN_MODEL: "custom-qwen",
        FREELLMAPI_DEEPSEEK_MODEL: "deepseek/custom-free",
        QWEN_CONTEXT_LIMIT: "64000",
        DEEPSEEK_CONTEXT_LIMIT: "128000",
      },
      { model: "qwen" },
    );
    expect(config.models.map(({ key, id, contextLimit }) => ({ key, id, contextLimit }))).toEqual([
      { key: "gemini", id: "gemini-3.8-flash", contextLimit: 1048576 },
      { key: "qwen", id: "custom-qwen", contextLimit: 64000 },
      { key: "deepseek", id: "deepseek/custom-free", contextLimit: 128000 },
    ]);
    expect(config.fallback).toBe(false);
  });
});
describe("provider chain", () => {
  const calls: string[] = [];
  function adapter(key: string, error?: Error): ModelAdapter {
    return {
      key,
      id: key,
      contextLimit: 10000,
      generate: async () => {
        calls.push(key);
        if (error) throw error;
        return {
          action: { tool: "request_completion", arguments: { summary: "done" } },
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
  }
  test("bounded retry before ordered fallback", async () => {
    calls.length = 0;
    const c = new ModelChain(
      [
        adapter("gemini", new ProviderError(true, true, "quota")),
        adapter("qwen", new ProviderError(true, false, "missing")),
        adapter("deepseek"),
      ],
      { model: "gemini", fallback: true, retries: 2 },
      undefined,
      async () => {},
    );
    await c.generate("context", new AbortController().signal, 100);
    expect(calls).toEqual(["gemini", "gemini", "gemini", "qwen", "deepseek"]);
  });
  test("ineligible errors do not fall back", async () => {
    calls.length = 0;
    const c = new ModelChain(
      [adapter("gemini", new ProviderError(false, false, "auth")), adapter("qwen")],
      { model: "gemini", fallback: true, retries: 0 },
    );
    await expect(c.generate("", new AbortController().signal, 100)).rejects.toThrow();
    expect(calls).toEqual(["gemini"]);
  });
  test("benchmark pin disables fallback", async () => {
    calls.length = 0;
    const c = new ModelChain(
      [adapter("gemini", new ProviderError(true, false, "missing")), adapter("qwen")],
      { model: "gemini", fallback: false, retries: 0 },
    );
    await expect(c.generate("", new AbortController().signal, 100)).rejects.toThrow();
    expect(calls).toEqual(["gemini"]);
  });
});

test("structured compaction survives repeated cycles and preserves failure evidence", async () => {
  const s = state();
  s.task = "fix preserved task";
  s.plan = [
    {
      id: "fix",
      content: "Resolve failure",
      status: "in_progress",
      notes: "suspect boundary condition",
    },
  ];
  const context = new ContextManager(s, new Hooks());
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let i = 0; i < 12; i++)
      context.add({
        tool: "run_shell",
        arguments: { command: "bun test" },
        output: JSON.stringify({
          exitCode: 1,
          stderr: "boundary assertion failed",
          padding: "x".repeat(2000),
        }),
      });
    const prompt = await context.build(12000, 100);
    expect(prompt).toContain("fix preserved task");
    expect(prompt).toContain("suspect boundary condition");
    const summary = JSON.parse(s.context.summary);
    expect(summary.unresolvedEvidence.length).toBeGreaterThan(0);
    expect(s.context.estimatedTokens).toBeLessThan(10800);
  }
});
test("tracing does not corrupt token-related code and rejects credential patches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-secret-"));
  try {
    const trace = new Trace(dir, ["known-test-secret"]);
    await trace.init({});
    const patch = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-token=old\n+token=new\n";
    await trace.finalPatch(patch);
    expect(await readFile(join(dir, "final.patch"), "utf8")).toBe(patch);
    await expect(trace.finalPatch("known-test-secret")).rejects.toThrow();
    await trace.event("test", { apiKey: "some-secret", tokenCount: 3 });
    const event = JSON.parse((await readFile(join(dir, "events.jsonl"), "utf8")).trim());
    expect(event.data.apiKey).toBe("<REDACTED>");
    expect(event.data.tokenCount).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("output bounds remain valid for tiny limits", () => {
  expect(boundOutput("x".repeat(1000), 20).text.length).toBeLessThanOrEqual(20);
});
