#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { type Instance, render } from "ink";
import { runAgent } from "./agent/orchestrator";
import { loadConfig } from "./config";
import { RunView } from "./ui/app";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let ui: Instance | undefined;
  const ac = new AbortController();
  const cancel = () => ac.abort();
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        model: { type: "string" },
        "max-turns": { type: "string" },
        timeout: { type: "string" },
        network: { type: "string" },
        "non-interactive": { type: "boolean" },
        benchmark: { type: "boolean" },
        "artifact-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (parsed.values.help) {
      console.log(
        'MiniCoder V1\nUsage: agent run <repo> "<task>" [--model gemini|qwen|deepseek] [--max-turns 50] [--timeout 900] [--network none|enabled] [--non-interactive] [--benchmark] [--artifact-dir <dir>]',
      );
      return 0;
    }
    const [command, repo, task, ...extra] = parsed.positionals;
    if (command !== "run" || !repo || !task || extra.length)
      throw new Error('Usage: agent run <repo> "<task>" (see --help)');
    const config = loadConfig();
    if (parsed.values.model) {
      const model = config.models.find(
        (x) => x.key === parsed.values.model || x.id === parsed.values.model,
      );
      if (!model)
        throw new Error("Unknown model: select gemini, qwen, deepseek or a configured model ID");
      config.model = model.key;
      config.fallback = false;
    }
    if (parsed.values.benchmark) config.fallback = false;
    for (const [input, key, multiplier] of [
      [parsed.values["max-turns"], "maxTurns", 1],
      [parsed.values.timeout, "timeoutMs", 1000],
    ] as const)
      if (input !== undefined) {
        const n = Number(input) * multiplier;
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Limits must be positive integers");
        config[key] = n;
      }
    if (parsed.values.network !== undefined) {
      if (!["none", "enabled"].includes(parsed.values.network))
        throw new Error("--network must be none or enabled");
      config.network = parsed.values.network === "enabled";
    }
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const interactive =
      !parsed.values["non-interactive"] && Boolean(process.stdout.isTTY && process.stdin.isTTY);
    const state = await runAgent({
      repo,
      task,
      config,
      artifactRoot: parsed.values["artifact-dir"],
      signal: ac.signal,
      onState: interactive
        ? (state) => {
            if (!ui)
              ui = render(<RunView state={state} cancel={cancel} />, {
                exitOnCtrlC: false,
                maxFps: 10,
              });
            else ui.rerender(<RunView state={state} cancel={cancel} />);
          }
        : undefined,
    });
    if (ui) {
      await ui.waitUntilRenderFlush();
      ui.unmount();
    } else
      console.log(
        JSON.stringify({
          id: state.id,
          status: state.status,
          model: state.model,
          turns: state.turn,
          ...state.usage,
          elapsedMs: state.elapsedMs,
          verification: state.verification,
          failure: state.failure,
          artifacts: state.artifacts,
        }),
      );
    return state.status === "SUCCESS" ? 0 : state.status === "CANCELLED" ? 130 : 1;
  } catch (e) {
    ui?.unmount();
    console.error(
      JSON.stringify({ status: "FAILED", message: e instanceof Error ? e.message : "CLI failed" }),
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
if (import.meta.main) process.exitCode = await main();
