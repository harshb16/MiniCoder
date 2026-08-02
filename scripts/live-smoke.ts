import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/orchestrator";
import { loadConfig } from "../src/config";
import { createAdapters } from "../src/models/adapters";
import { processRun } from "../src/sandbox/process";

const selector = process.argv[2] ?? "gemini";
if (!["gemini", "kimi", "deepseek", "fallback"].includes(selector))
  throw new Error("Select gemini, kimi, deepseek, or fallback");
const config = loadConfig(process.env, {
  model: selector === "kimi" ? "kimi" : selector === "deepseek" ? "deepseek" : "gemini",
  fallback: selector === "fallback",
  maxTurns: 20,
  timeoutMs: 300000,
  commandTimeoutMs: 10000,
});
const root = await mkdtemp(join(tmpdir(), "minicoder-live-"));
const repo = join(root, "repo");
await cp(join(import.meta.dir, "../fixtures/tiny"), repo, { recursive: true });
try {
  const init = await processRun("git", ["init", repo]);
  if (init.exitCode !== 0) throw new Error(init.stderr);
  const before = await readFile(join(repo, "math.ts"), "utf8");
  // Explicitly omit the primary credential for a controlled availability-fallback smoke test.
  const adapters = createAdapters(
    config,
    selector === "fallback" ? { ...process.env, GEMINI_API_KEY: "" } : process.env,
  );
  let phase = "";
  const result = await runAgent({
    repo,
    task: "Fix add(a, b) in math.ts so it adds instead of subtracting. Inspect the file, make the smallest patch, run bun test, and request runtime completion when it passes.",
    config,
    adapters,
    artifactRoot: join(root, ".agent/runs"),
    onState: (s) => {
      const next = `${s.status}:${s.turn}:${s.model}`;
      if (next !== phase) {
        console.error(next);
        phase = next;
      }
    },
  });
  if ((await readFile(join(repo, "math.ts"), "utf8")) !== before)
    throw new Error("Original repository modified");
  if (result.status === "SUCCESS") {
    const patch = await readFile(join(result.artifacts, "final.patch"), "utf8");
    const apply = await processRun("git", ["-C", repo, "apply", "--check", "-"], { input: patch });
    if (apply.exitCode !== 0 || !patch.includes("+  return a + b;"))
      throw new Error("Unexpected exported patch");
  }
  console.log(
    JSON.stringify({
      status: result.status,
      model: result.model,
      turns: result.turn,
      fallbackCount: result.usage.fallbackCount,
      hostUnchanged: true,
      verification: result.verification?.passed,
      failure: result.failure,
      artifacts: result.artifacts,
    }),
  );
  process.exitCode = result.status === "SUCCESS" ? 0 : 1;
} finally {
  await rm(repo, { recursive: true, force: true });
}
