import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/orchestrator";
import { loadConfig } from "../src/config";
import type { ModelAdapter } from "../src/models/adapters";
import type { Action } from "../src/models/schema";
import { processRun } from "../src/sandbox/process";

const actions: Action[] = [
  {
    tool: "update_plan",
    arguments: {
      plan: [
        { id: "inspect", content: "Inspect arithmetic implementation", status: "in_progress" },
        { id: "fix", content: "Fix addition and verify", status: "pending" },
      ],
    },
  },
  { tool: "list_tree", arguments: {} },
  { tool: "tree_sitter_symbols", arguments: { path: "math.ts" } },
  { tool: "read_file", arguments: { path: "math.ts" } },
  {
    tool: "edit_file",
    arguments: {
      path: "math.ts",
      patch:
        "--- a/math.ts\n+++ b/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a - b;\n+  return a + b;\n }\n",
    },
  },
  { tool: "run_shell", arguments: { command: "bun test", cwd: ".", timeoutMs: 10000 } },
  { tool: "git", arguments: { operation: "diff" } },
  {
    tool: "update_plan",
    arguments: {
      plan: [
        { id: "inspect", content: "Inspect arithmetic implementation", status: "done" },
        { id: "fix", content: "Fix addition and verify", status: "done" },
      ],
    },
  },
  { tool: "request_completion", arguments: { summary: "Addition fixed and fixture tests pass" } },
];
const root = await mkdtemp(join(tmpdir(), "minicoder-smoke-"));
const repo = join(root, "repo");
await cp(join(import.meta.dir, "../fixtures/tiny"), repo, { recursive: true });
try {
  const init = await processRun("git", ["init", repo]);
  if (init.exitCode !== 0) throw new Error(init.stderr);
  const before = await readFile(join(repo, "math.ts"), "utf8");
  const adapter: ModelAdapter = {
    key: "gemini",
    id: "deterministic-fixture",
    contextLimit: 32000,
    generate: async () => {
      const action = actions.shift();
      if (!action) throw new Error("Smoke action sequence exhausted");
      return { action, inputTokens: 100, outputTokens: 50 };
    },
  };
  let phase = "";
  const result = await runAgent({
    repo,
    task: "Fix add(a, b) so it adds instead of subtracting.",
    config: loadConfig(
      {},
      { maxTurns: 12, timeoutMs: 180000, commandTimeoutMs: 10000, fallback: false },
    ),
    artifactRoot: join(root, ".agent/runs"),
    adapters: [adapter],
    onState: (s) => {
      const next = `${s.status}:${s.turn}:${s.sandbox}`;
      if (next !== phase) {
        console.error(`smoke ${next}`);
        phase = next;
      }
    },
  });
  if (result.status !== "SUCCESS")
    throw new Error(
      JSON.stringify({
        status: result.status,
        failure: result.failure,
        verification: result.verification,
      }),
    );
  if ((await readFile(join(repo, "math.ts"), "utf8")) !== before)
    throw new Error("Original source changed");
  const patch = await readFile(join(result.artifacts, "final.patch"), "utf8");
  if (!patch.includes("+  return a + b;")) throw new Error("Expected patch missing");
  const apply = await processRun("git", ["-C", repo, "apply", "--check", "-"], { input: patch });
  if (apply.exitCode !== 0) throw new Error(`Exported patch invalid: ${apply.stderr}`);
  const events = (await readFile(join(result.artifacts, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  for (const event of ["plan_change", "tool_call", "verification", "checkpoint", "model_result"])
    if (!events.some((x) => x.type === event)) throw new Error(`Missing trace event ${event}`);
  console.log(
    JSON.stringify({
      status: result.status,
      model: result.model,
      turns: result.turn,
      hostUnchanged: true,
      patchValid: true,
      artifacts: result.artifacts,
    }),
  );
} finally {
  // Keep diagnostics and artifacts for review; only remove the fixture input copy.
  await rm(repo, { recursive: true, force: true });
}
