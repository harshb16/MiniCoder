import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/orchestrator";
import { loadConfig } from "../src/config";
import type { ModelAdapter } from "../src/models/adapters";
import type { Action } from "../src/models/schema";
import type { Verification } from "../src/runtime/types";
import { processRun } from "../src/sandbox/process";
import { createRunDisplay } from "../src/ui/app";

function replaceTests(source: string): Action {
  return {
    tool: "run_shell",
    arguments: {
      cwd: ".",
      command: `cat > math.test.ts <<'FIXTURE_TEST'\n${source}\nFIXTURE_TEST`,
    },
  };
}
const tests = (
  await readFile(join(import.meta.dir, "../fixtures/tiny/math.test.ts"), "utf8")
).trimEnd();
const mutateAfterTest = tests
  .replace("import { add }", 'import { writeFileSync } from "node:fs";\nimport { add }')
  .replace(
    "  expect(add(-2, 3)).toBe(1);",
    `  expect(add(-2, 3)).toBe(1);
  writeFileSync("math.ts", "export const add = () => 999;\\n");`,
  );
const fix: Action = {
  tool: "edit_file",
  arguments: {
    path: "math.ts",
    patch:
      "--- a/math.ts\n+++ b/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a - b;\n+  return a + b;\n }\n",
  },
};
const complete: Action = { tool: "request_completion", arguments: { summary: "Fixture ready" } };
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
  replaceTests('import { test } from "bun:test";\ntest("always passes", () => {});'),
  {
    tool: "update_plan",
    arguments: {
      plan: [
        { id: "inspect", content: "Inspect arithmetic implementation", status: "done" },
        { id: "fix", content: "Fix addition and verify", status: "done" },
      ],
    },
  },
  complete,
  fix,
  replaceTests(mutateAfterTest),
  complete,
  replaceTests(tests),
  {
    tool: "edit_file",
    arguments: {
      path: "math.ts",
      patch:
        "--- a/math.ts\n+++ b/math.ts\n@@ -1 +1,3 @@\n-export const add = () => 999;\n+export function add(a: number, b: number): number {\n+  return a + b;\n+}\n",
    },
  },
  { tool: "run_shell", arguments: { command: "bun test", cwd: ".", timeoutMs: 10000 } },
  { tool: "git", arguments: { operation: "diff" } },
  complete,
];
async function main() {
  const tui = process.argv.includes("--tui");
  if (tui && !(process.stdin.isTTY && process.stdout.isTTY))
    throw new Error("--tui requires a terminal");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const display = tui ? createRunDisplay(cancel) : undefined;
  const root = await mkdtemp(join(tmpdir(), "minicoder-smoke-"));
  const repo = join(root, "repo");
  await cp(join(import.meta.dir, "../fixtures/tiny"), repo, { recursive: true });
  try {
    if (display) {
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
    }
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
        { maxTurns: actions.length, timeoutMs: 300000, commandTimeoutMs: 10000, fallback: false },
      ),
      acceptanceFile: join(import.meta.dir, "../fixtures/acceptance/tiny.json"),
      artifactRoot: join(root, ".agent/runs"),
      adapters: [adapter],
      signal: controller.signal,
      onState:
        display?.update ??
        ((s) => {
          const next = `${s.status}:${s.turn}:${s.sandbox}`;
          if (next !== phase) {
            console.error(`smoke ${next}`);
            phase = next;
          }
        }),
    });
    if (display && result.status === "CANCELLED") {
      process.exitCode = 130;
      return;
    }
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
    if (!patch.includes("+  return a + b;") || result.modified.join(",") !== "math.ts")
      throw new Error("Unexpected exported patch");
    const apply = await processRun("git", ["-C", repo, "apply", "--check", "-"], { input: patch });
    if (apply.exitCode !== 0) throw new Error(`Exported patch invalid: ${apply.stderr}`);
    const events = (await readFile(join(result.artifacts, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    for (const event of ["plan_change", "tool_call", "verification", "checkpoint", "model_result"])
      if (!events.some((x) => x.type === event)) throw new Error(`Missing trace event ${event}`);
    const [baseline, weakened, mutated, fixed, ...extra]: Verification[] = events
      .filter((x) => x.type === "verification")
      .map((x) => x.data);
    if (
      extra.length ||
      baseline?.repositoryChecks.status !== "failed" ||
      weakened?.repositoryChecks.status !== "passed" ||
      weakened.repositoryChecks.changedCandidate ||
      weakened.trustedAcceptance.status !== "failed" ||
      mutated?.repositoryChecks.status !== "passed" ||
      !mutated.repositoryChecks.changedCandidate ||
      mutated.trustedAcceptance.status !== "failed" ||
      mutated.trustedAcceptance.fingerprint !== mutated.fingerprint ||
      fixed?.repositoryChecks.status !== "passed" ||
      fixed.repositoryChecks.changedCandidate ||
      fixed.trustedAcceptance.status !== "passed"
    )
      throw new Error("Unexpected repository and trusted acceptance evidence");
    const accepted = result.verification?.trustedAcceptance;
    if (
      accepted?.status !== "passed" ||
      accepted.fingerprint !== fixed.fingerprint ||
      accepted.patchSha256 !== createHash("sha256").update(patch).digest("hex")
    )
      throw new Error("Trusted acceptance does not bind the exported patch");
    if (display) return;
    for (const [label, evidence] of [
      ["weakened-test", weakened],
      ["verification-mutation", mutated],
      ["source-fix", fixed],
    ] as const)
      console.log(
        `${label}: repository=${evidence.repositoryChecks.status} candidate-changed=${evidence.repositoryChecks.changedCandidate} trusted=${evidence.trustedAcceptance.status}`,
      );
    console.log(
      JSON.stringify({
        status: result.status,
        model: result.model,
        turns: result.turn,
        hostUnchanged: true,
        patchValid: true,
        trustedAcceptance: accepted,
        artifacts: result.artifacts,
      }),
    );
  } finally {
    await display?.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    // Keep diagnostics and artifacts for review; only remove the fixture input copy.
    await rm(repo, { recursive: true, force: true });
  }
}
await main();
