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
        "--- a/math.ts\n+++ b/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a - b;\n+  return a + b;\n }\n";
      await sandbox.tool("edit_file", { path: "math.ts", patch }, signal);
      expect(await readFile(join(dir, "math.ts"), "utf8")).toContain("a - b");
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
