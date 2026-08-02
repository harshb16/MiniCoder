import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { DockerSandbox } from "../src/sandbox/docker";

const dockerTest = process.env.MINICODER_DOCKER_TESTS === "1" ? test : test.skip;
dockerTest(
  "Docker isolation, tools, patch validation, tree-sitter, timeout and cleanup",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mini-docker-"));
    await cp(join(import.meta.dir, "../fixtures/tiny"), dir, { recursive: true });
    const sandbox = new DockerSandbox(loadConfig({}, { commandTimeoutMs: 10000 }));
    const signal = new AbortController().signal;
    try {
      await sandbox.initialize(dir, signal);
      const tree = (await sandbox.tool("list_tree", {}, signal)) as { files: string[] };
      expect(tree.files).toContain("math.ts");
      const symbols = (await sandbox.tool("tree_sitter_symbols", { path: "math.ts" }, signal)) as {
        symbols: { name: string }[];
      };
      expect(symbols.symbols.map((x) => x.name)).toContain("add");
      const search = (await sandbox.tool("ripgrep", { pattern: "return" }, signal)) as {
        matches: string[];
      };
      expect(search.matches.length).toBe(1);
      await expect(sandbox.tool("read_file", { path: "../etc/passwd" }, signal)).rejects.toThrow();
      await expect(
        sandbox.tool(
          "edit_file",
          { path: "math.ts", patch: "--- a/elsewhere\n+++ b/elsewhere\n@@ -1 +1 @@\n-a\n+b\n" },
          signal,
        ),
      ).rejects.toThrow();
      const patch =
        "--- a/math.ts\n+++ b/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a - b;\n+  return a + b;\n }";
      await sandbox.tool("edit_file", { path: "math.ts", patch }, signal);
      expect(await readFile(join(dir, "math.ts"), "utf8")).toContain("a - b");
      await sandbox.tool(
        "edit_file",
        {
          path: "math.ts",
          patch:
            "--- a/math.ts\n+++ b/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n   return a + b;\n-}\n+}\n\\ No newline at end of file",
        },
        signal,
      );
      const read = (await sandbox.tool("read_file", { path: "math.ts" }, signal)) as {
        totalLines: number;
      };
      expect(read.totalLines).toBe(3);
      const result = await sandbox.shell("bun test", 10000, signal);
      expect(result.exitCode).toBe(0);
      const r = await sandbox.shell("sleep 30 & wait", 50, signal);
      expect(r.timedOut).toBe(true);
      const identity = await sandbox.shell("id -u; test ! -d /control/repo", 10000, signal);
      expect(identity.exitCode).toBe(0);
      expect(identity.stdout.trim()).toBe("1000");
      const network = await sandbox.shell("cat /proc/net/route", 10000, signal);
      expect(network.stdout.trim().split("\n").length).toBe(1);
    } finally {
      await sandbox.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);

dockerTest(
  "Docker checkpoint restore and independent regression verification",
  async () => {
    const { Trace } = await import("../src/runtime/trace");
    const { Checkpoints } = await import("../src/runtime/checkpoints");
    const { Verifier } = await import("../src/runtime/verifier");
    const { state } = await import("./helpers");
    const dir = await mkdtemp(join(tmpdir(), "mini-recovery-"));
    const source = join(dir, "repo");
    await cp(join(import.meta.dir, "../fixtures/tiny"), source, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(source, "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    const sandbox = new DockerSandbox(loadConfig({}, { commandTimeoutMs: 10000 }));
    const signal = new AbortController().signal;
    const trace = new Trace(join(dir, "run"));
    await trace.init({});
    const s = state();
    try {
      await sandbox.initialize(source, signal);
      const points = new Checkpoints(sandbox, s, trace);
      await points.initialize(signal);
      const verifier = new Verifier(
        sandbox,
        points,
        { commands: ["bun test"], source: "configured" },
        trace,
        10000,
      );
      expect((await verifier.verify(signal)).passed).toBe(true);
      const validated = await points.snapshot("validated", signal);
      await points.snapshot("operational", signal);
      await sandbox.tool(
        "edit_file",
        {
          path: "math.ts",
          patch:
            "--- a/math.ts\n+++ b/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a + b;\n+  return a - b;\n }\n",
        },
        signal,
      );
      expect((await verifier.verify(signal)).passed).toBe(false);
      await points.restore(validated, signal);
      expect((await verifier.verify(signal)).passed).toBe(true);
      await sandbox.tool(
        "edit_file",
        {
          path: "math.ts",
          patch:
            "--- a/math.ts\n+++ b/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a + b;\n+  return a + b + 0;\n }\n",
        },
        signal,
      );
      expect((await verifier.verify(signal)).passed).toBe(true);
    } finally {
      await sandbox.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
