import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config";
import { createAdapters, type ModelAdapter, ModelChain } from "../models/adapters";
import type { Action, ToolName } from "../models/schema";
import { ActionSchema, toolSchemas } from "../models/schema";
import { Budgets, LoopDetector } from "../runtime/budgets";
import { Checkpoints } from "../runtime/checkpoints";
import { Hooks } from "../runtime/hooks";
import { RecoveryPolicy } from "../runtime/recovery";
import { Trace } from "../runtime/trace";
import { RunError, type RunState, replacePlan, type Status, transition } from "../runtime/types";
import { detectVerification, Verifier } from "../runtime/verifier";
import { copyRepository } from "../sandbox/copy";
import { DockerSandbox, type Sandbox } from "../sandbox/docker";
import { McpTools } from "../tools/mcp";
import { normalizePath, shellPolicy } from "../tools/policy";
import { ContextManager } from "./context";

export interface RunOptions {
  repo: string;
  task: string;
  config: Config;
  artifactRoot?: string;
  signal?: AbortSignal;
  onState?: (state: RunState) => void;
  hooks?: Hooks;
  // Injectable deterministic model/sandbox seams are for tests, never a CLI host-shell alternative.
  adapters?: ModelAdapter[];
  sandbox?: Sandbox & { initialize(source: string, signal: AbortSignal): Promise<void> };
}
export async function runAgent(options: RunOptions): Promise<RunState> {
  const { config } = options;
  const repo = await realpath(options.repo);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  let artifactRoot = resolve(
    options.artifactRoot ?? join(homedir(), ".local/state/minicoder/.agent/runs"),
  );
  let existing = artifactRoot;
  const missing: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      missing.unshift(existing.split("/").pop() ?? "");
      const parent = resolve(existing, "..");
      if (parent === existing) throw e;
      existing = parent;
    }
  }
  artifactRoot = join(existing, ...missing);
  const rel = relative(repo, artifactRoot);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
    throw new Error("Artifacts must be outside the original repository");
  const state: RunState = {
    id,
    task: options.task,
    repo,
    status: "CREATED",
    model: config.models.find((x) => x.key === config.model)?.id ?? config.model,
    turn: 0,
    plan: [],
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    budgets: {
      maxTurns: config.maxTurns,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      commandTimeoutMs: config.commandTimeoutMs,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      toolCounts: {},
      fallbackCount: 0,
      recoveryCount: 0,
    },
    context: { summary: "", estimatedTokens: 0, limit: 0, compactions: 0 },
    checkpoints: {},
    sandbox: "initializing",
    recovery: "none",
    inspected: [],
    modified: [],
    activity: [],
    artifacts: join(artifactRoot, id),
  };
  const trace = new Trace(state.artifacts, [
    process.env.GEMINI_API_KEY ?? "",
    process.env.FREELLMAPI_API_KEY ?? "",
  ]);
  await trace.init({
    id,
    repo,
    task: options.task,
    version: "1.0.0",
    config: { ...config, freeTierConfirmed: config.freeTierConfirmed },
  });
  const ac = new AbortController();
  const externalAbort = () => ac.abort(new RunError("CANCELLED", "User cancelled run"));
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const wallTimer = setTimeout(
    () => ac.abort(new RunError("BUDGET_EXHAUSTED", "Wall-clock timeout")),
    config.timeoutMs,
  );
  const signal = ac.signal;
  const hooks = options.hooks ?? new Hooks();
  const sandbox = options.sandbox ?? new DockerSandbox(config);
  const budget = new Budgets(state);
  const loop = new LoopDetector();
  const context = new ContextManager(state, hooks);
  const checkpoints = new Checkpoints(sandbox, state, trace);
  const recovery = new RecoveryPolicy();
  let mcp: McpTools | undefined;
  let stage: string | undefined;
  let ready = false;
  let requested = false;
  let verifier: Verifier;
  const publish = async () => {
    state.elapsedMs = Date.now() - Date.parse(state.startedAt);
    await trace.save(state);
    options.onState?.(structuredClone(state));
  };
  const activity = (text: string) => {
    state.activity.push(trace.redact(text));
    state.activity = state.activity.slice(-8);
  };
  for (const name of [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "PreCompact",
  ] as const)
    hooks.on(name, async (data) => {
      await trace.event(name, data);
    });
  hooks.on("PreToolUse", async (data) => {
    budget.check(signal);
    const args = data.arguments as Record<string, unknown>;
    for (const key of ["path", "cwd"])
      if (typeof args[key] === "string") normalizePath("/workspace", args[key]);
    if (data.tool === "run_shell") shellPolicy(String(args.command));
    await trace.event("tool_call", data);
    activity(
      `${data.tool} ${typeof args.path === "string" ? args.path : typeof args.command === "string" ? args.command.slice(0, 120) : ""}`,
    );
  });
  hooks.on("PostToolUse", async (data) => {
    const tool = String(data.tool);
    state.usage.toolCounts[tool] = (state.usage.toolCounts[tool] ?? 0) + 1;
    await trace.event("tool_result", data);
    if (data.failed) await trace.event("failure", { code: "TOOL_ERROR", tool });
    const result = data.result as { timedOut?: boolean; omittedBytes?: number };
    if (result?.timedOut) await trace.event("failure", { code: "COMMAND_TIMEOUT", tool });
    if (result?.omittedBytes)
      await trace.event("failure", {
        code: "OUTPUT_TRUNCATED",
        tool,
        omittedBytes: result.omittedBytes,
      });
    await publish();
  });
  async function execute(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
    budget.check(signal);
    if (name === "update_plan") {
      const parsed = toolSchemas.update_plan.parse(args);
      if (state.plan.length && JSON.stringify(parsed.plan) !== JSON.stringify(state.plan))
        await checkpoints.snapshot("operational", signal);
      replacePlan(state, parsed.plan);
      await trace.event("plan_change", state.plan);
      return { plan: state.plan };
    }
    if (name === "request_completion") {
      if (!state.plan.length || state.plan.some((item) => item.status !== "done"))
        throw new RunError(
          "TOOL_ERROR",
          "Complete the current plan before requesting verification",
        );
      requested = true;
      return { verificationRequested: true };
    }
    if (name === "git") {
      const a = toolSchemas.git.parse(args);
      let cmd: string[];
      if (a.operation === "diff") return { diff: await checkpoints.diff(signal) };
      if (a.operation === "status") cmd = ["status", "--short"];
      else if (a.operation === "log") cmd = ["log", "-5", "--oneline"];
      else cmd = ["show", "--no-ext-diff", "--no-textconv", "--stat", a.revision ?? "HEAD", "--"];
      const result = await sandbox.git(cmd, signal);
      if (result.exitCode !== 0) throw new RunError("TOOL_ERROR", result.stderr);
      return result;
    }
    if (["edit_file", "run_shell"].includes(name) && !state.plan.length)
      throw new RunError("TOOL_ERROR", "Write a plan before editing or executing commands");
    if (name === "run_shell") await checkpoints.snapshot("operational", signal);
    if (name === "edit_file") {
      const patch = String(args.patch);
      if (trace.containsSecret(patch))
        throw new RunError("TOOL_ERROR", "Credential material is not allowed in edits");
      await checkpoints.snapshot("operational", signal);
      await trace.patch(state.turn, patch);
    }
    const result = await sandbox.tool(name, args, signal);
    if (
      ["read_file", "tree_sitter_symbols"].includes(name) &&
      typeof args.path === "string" &&
      !state.inspected.includes(args.path)
    )
      state.inspected.push(args.path);
    return result;
  }
  try {
    await hooks.emit("SessionStart", { id, budgets: state.budgets });
    await hooks.emit("UserPromptSubmit", { task: state.task });
    await publish();
    const adapters = options.adapters ?? createAdapters(config);
    const chain = new ModelChain(adapters, config, async (event, data) => {
      if (event === "model_call") {
        state.usage.modelCalls++;
        state.model = String(data.model);
        activity(`model ${state.model}`);
      }
      if (event === "model_fallback") {
        state.usage.fallbackCount++;
        await hooks.emit("Notification", { message: "Provider fallback", model: data.model });
      }
      await trace.event(event, data);
      await publish();
    });
    stage = await mkdtemp(join(tmpdir(), "minicoder-source-"));
    const copied = await copyRepository(repo, stage, signal);
    await trace.event("repository_copy", { files: copied.files });
    const verifyConfig = await detectVerification(stage, copied.config);
    await trace.event("verification_config", verifyConfig);
    await sandbox.initialize(stage, signal);
    await checkpoints.initialize(signal);
    ready = true;
    state.sandbox = "ready: isolated Docker volume";
    await rm(stage, { recursive: true, force: true });
    stage = undefined;
    for (const command of copied.config.bootstrap) {
      budget.check(signal);
      activity(`bootstrap ${command}`);
      await publish();
      const result = await sandbox.shell(
        command,
        config.commandTimeoutMs,
        signal,
        config.bootstrapNetwork,
      );
      await trace.event("bootstrap", { command, result });
      if (result.exitCode !== 0 || result.timedOut)
        throw new RunError("SANDBOX_ERROR", "Bootstrap command failed");
    }
    verifier = new Verifier(sandbox, checkpoints, verifyConfig, trace, config.commandTimeoutMs);
    activity("verify input baseline");
    await publish();
    state.verification = await verifier.verify(signal);
    if (state.verification.passed) await checkpoints.snapshot("validated", signal);
    recovery.observe(state.verification, state.checkpoints.validated);
    transition(state, "RUNNING");
    mcp = new McpTools({ execute }, hooks, trace, config.outputChars);
    await mcp.start();
    let invalidResponses = 0;
    for (;;) {
      budget.check(signal, true);
      const reserve = Math.min(
        4096,
        Math.max(1, state.budgets.maxTokens - state.usage.inputTokens - state.usage.outputTokens),
      );
      const limit = config.fallback
        ? Math.min(...adapters.map((x) => x.contextLimit))
        : chain.current.contextLimit;
      const prompt = await context.build(limit, reserve);
      if (
        state.usage.inputTokens +
          state.usage.outputTokens +
          Math.ceil(prompt.length / 3) +
          reserve >
        state.budgets.maxTokens
      )
        throw new RunError(
          "BUDGET_EXHAUSTED",
          "Model token budget cannot accommodate another turn",
        );
      state.turn++;
      await publish();
      let action: Action;
      try {
        const result = await chain.generate(prompt, signal, reserve);
        state.model = chain.current.id;
        state.usage.inputTokens += result.inputTokens;
        state.usage.outputTokens += result.outputTokens;
        action = ActionSchema.parse(result.action);
        invalidResponses = 0;
        await trace.event("model_result", {
          model: state.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          action,
        });
      } catch (e) {
        if (e instanceof RunError && e.usage) {
          state.usage.inputTokens += e.usage.inputTokens;
          state.usage.outputTokens += e.usage.outputTokens;
        }
        if (
          e instanceof RunError &&
          e.code === "MODEL_RESPONSE_INVALID" &&
          ++invalidResponses <= 2
        ) {
          await trace.event("failure", { code: e.code, message: e.message });
          context.add({
            tool: "model_response",
            arguments: {},
            output:
              "Invalid typed action. Return one JSON action with the documented argument schema.",
          });
          await publish();
          continue;
        }
        throw e;
      }
      requested = false;
      const result = await mcp.call(action, signal);
      context.add({ tool: action.tool, arguments: action.arguments, output: result.output });
      budget.check(signal);
      state.modified = await checkpoints.changed(signal);
      const fingerprint = `${await checkpoints.fingerprint(signal)}:${JSON.stringify(state.plan)}:${state.inspected.length}`;
      loop.observe(action.tool, action.arguments, fingerprint);
      if (requested && !result.failed) {
        transition(state, "VERIFYING");
        activity("runtime verification");
        await publish();
        state.verification = await verifier.verify(signal);
        if (state.verification.passed) {
          await checkpoints.snapshot("validated", signal);
          budget.check(signal);
          transition(state, "SUCCESS", true);
          break;
        }
        await trace.event("failure", {
          code: "VERIFICATION_FAILED",
          errors: state.verification.errors,
        });
        if (
          recovery.observe(state.verification, state.checkpoints.validated) === "restore" &&
          state.checkpoints.validated
        ) {
          const evidence = state.verification;
          await checkpoints.restore(state.checkpoints.validated, signal);
          state.modified = await checkpoints.changed(signal);
          state.verification = await verifier.verify(signal);
          if (!state.verification.passed)
            throw new RunError("SANDBOX_ERROR", "Restored checkpoint no longer verifies");
          state.usage.recoveryCount++;
          state.recovery = "restored latest validated checkpoint after two repair cycles";
          await trace.event("recovery", {
            reason: state.recovery,
            checkpoint: state.checkpoints.validated,
            errors: evidence.errors,
          });
          context.add({
            tool: "recovery",
            arguments: {},
            output: JSON.stringify({
              restored: true,
              checkpoint: state.checkpoints.validated,
              failedEvidence: evidence,
              next: "Reinspect restored files and choose a different implementation.",
            }),
          });
          await hooks.emit("Notification", { message: state.recovery });
        } else {
          state.recovery = "verification failed; repair permitted";
        }
        context.add({
          tool: "verification",
          arguments: {},
          output: JSON.stringify(state.verification),
        });
        transition(state, "RUNNING");
      }
      await publish();
    }
  } catch (e) {
    const error = signal.aborted ? signal.reason : e;
    const failure =
      error instanceof RunError
        ? error
        : new RunError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Unexpected runtime failure",
          );
    const terminal: Status = [
      "CANCELLED",
      "MODEL_UNAVAILABLE",
      "BUDGET_EXHAUSTED",
      "LOOP_DETECTED",
    ].includes(failure.code)
      ? (failure.code as Status)
      : "FAILED";
    if (
      ![
        "SUCCESS",
        "FAILED",
        "CANCELLED",
        "MODEL_UNAVAILABLE",
        "BUDGET_EXHAUSTED",
        "LOOP_DETECTED",
      ].includes(state.status)
    )
      transition(state, terminal);
    state.failure = { code: failure.code, message: trace.redact(failure.message) };
    await trace.event("failure", state.failure);
  } finally {
    clearTimeout(wallTimer);
    options.signal?.removeEventListener("abort", externalAbort);
    if (mcp)
      await mcp
        .close()
        .catch((e) => trace.event("cleanup_error", { component: "mcp", message: String(e) }));
    // Export partial work even after cancellation, using a fresh bounded cleanup signal.
    if (ready)
      try {
        const cleanupSignal = AbortSignal.timeout(10000);
        const patch = await checkpoints.diff(cleanupSignal);
        state.modified = await checkpoints.changed(cleanupSignal);
        await trace.finalPatch(patch);
      } catch (e) {
        await trace.event("patch_export_failed", { message: String(e) });
        await writeFile(join(state.artifacts, "final.patch"), "", { mode: 0o600 });
        if (state.status === "SUCCESS") {
          state.status = "FAILED";
          state.failure = { code: "INTERNAL_ERROR", message: "Final patch export failed" };
        }
      }
    else await writeFile(join(state.artifacts, "final.patch"), "");
    let cleaned = true;
    await sandbox.cleanup().catch(async (e) => {
      cleaned = false;
      await trace.event("cleanup_error", { component: "sandbox", message: String(e) });
    });
    if (stage) await rm(stage, { recursive: true, force: true });
    state.sandbox = cleaned ? "cleaned" : "cleanup failed; inspect Docker resources";
    state.finishedAt = new Date().toISOString();
    await hooks.emit("Stop", { status: state.status });
    await hooks.emit("SessionEnd", { status: state.status });
    await publish();
    await trace.json("report.json", {
      id: state.id,
      success: state.status === "SUCCESS",
      status: state.status,
      model: state.model,
      turns: state.turn,
      ...state.usage,
      elapsedMs: state.elapsedMs,
      verification: state.verification,
      failure: state.failure,
      artifacts: state.artifacts,
    });
  }
  return state;
}
