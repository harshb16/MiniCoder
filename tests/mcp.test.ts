import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hooks } from "../src/runtime/hooks";
import { Trace } from "../src/runtime/trace";
import { McpTools } from "../src/tools/mcp";

test("real Streamable HTTP tool registration, typed dispatch, hooks and bounded results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-mcp-"));
  const trace = new Trace(dir);
  await trace.init({ test: true });
  const hooks = new Hooks();
  let pre = 0,
    post = 0;
  hooks.on("PreToolUse", () => {
    pre++;
  });
  hooks.on("PostToolUse", () => {
    post++;
  });
  const mcp = new McpTools(
    { execute: async () => ({ content: "x".repeat(30000) }) },
    hooks,
    trace,
    1000,
  );
  try {
    await mcp.start();
    expect(await mcp.list()).toContain("request_completion");
    const r = await mcp.call({ tool: "read_file", arguments: { path: "a" } });
    expect(r.failed).toBe(false);
    expect(r.output.length).toBeLessThanOrEqual(1000);
    expect(r.output).toContain("OUTPUT_TRUNCATED");
    expect(pre).toBe(1);
    expect(post).toBe(1);
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toContain("OUTPUT_TRUNCATED");
  } finally {
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP shutdown drains an in-flight tool after client cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-mcp-cancel-"));
  const trace = new Trace(dir);
  await trace.init({});
  let finish: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let posted = false;
  const hooks = new Hooks();
  hooks.on("PostToolUse", () => {
    posted = true;
  });
  const mcp = new McpTools(
    {
      execute: async () => {
        entered();
        await pending;
        return { ok: true };
      },
    },
    hooks,
    trace,
  );
  try {
    await mcp.start();
    const ac = new AbortController();
    const call = mcp.call({ tool: "read_file", arguments: { path: "a" } }, ac.signal);
    const observed = call.catch(() => {});
    await started;
    ac.abort();
    let closed = false;
    const close = mcp.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await observed;
    await close;
    expect(posted).toBe(true);
    expect(closed).toBe(true);
  } finally {
    finish();
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});
