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
