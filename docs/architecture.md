# MiniCoder V1 architecture

## Boundaries

```text
bin/agent -> CLI / Ink TUI
                 |
                 v
           Orchestrator -----> budgets, hooks, state, trace
                 |
                 v
       single agent action loop
           |             |
           v             v
      context manager -> model chain -> provider adapters
           |
           v
   MCP client -> authenticated Streamable HTTP server
                        |
                        v
              typed tool executor -> Docker sandbox -> immutable worker

   Orchestrator -> independent verifier -> checkpoints / deterministic recovery
        |
        v
   JSON state + JSONL events + outputs + patches + report
```

`src/cli.tsx` parses only `run`; it selects limits, pins models, manages signals and UI, and prints JSON in non-interactive mode. `bin/agent` is the generic executable. `src/ui/app.tsx` renders a RunState snapshot and maps Ctrl-C to cancellation; it contains no policy or agent decisions.

`src/agent/orchestrator.ts` owns the run, one sequential action loop, and the only production path to success. It coordinates setup, model selection, MCP dispatch, verification, recovery, persistence, and cleanup. Typed model actions use shared Zod schemas in `src/models/schema.ts`. The Gemini JSON response schema is generated from those same tool schemas; FreeLLMAPI uses JSON mode plus deterministic runtime validation. Neither adapter parses narrative prose for actions.

`src/models/adapters.ts` contains the official Google GenAI SDK adapter, one generic OpenAI-compatible FreeLLMAPI adapter, explicit provider error classification, and bounded retry/fallback. It never receives a sandbox execution capability. Transport responses containing private reasoning fields are not copied into run traces; only public typed actions and usage metadata are retained.

`src/tools/mcp.ts` starts a private loopback MCP Streamable HTTP server and SDK client per run. All coding/control actions traverse this transport, including deterministic smoke actions. It validates schemas, invokes policy hooks, stores raw redacted results, bounds model-visible text, and drains in-flight actions on shutdown. The capability token is never written to artifacts or exposed to the model.

`src/sandbox/docker.ts` is the sole production shell executor. The host process spawns Docker with argument arrays, never interpolated agent shell text. `src/tools/worker.ts`, baked into the read-only image, runs file inspection, tree-sitter, ripgrep, patch validation, and bash inside Docker. The Sandbox interface is intentionally narrow and has an injectable deterministic test seam; CLI provides no host execution mode.

`src/runtime/verifier.ts` freezes configured/autodetected commands from the pre-agent source copy. It invokes independent Docker tests and audits. `checkpoints.ts` controls private Git objects, and `recovery.ts` decides when a verified regression warrants restoring a checkpoint. `types.ts`, `budgets.ts`, `hooks.ts`, and `trace.ts` provide state transitions, hard limits, real lifecycle extensions, and persistence.

## Invariants

1. One coding agent selects actions. There are no planner/coder/tester/reviewer sub-agents.
2. Repository code, bootstrap, tests, and every agent command execute in Docker.
3. Host Git is used only to inventory source; it disables hooks/fsmonitor and optional locks. The host source is not modified. Artifacts are canonicalized outside that repository, including symlinked output locations.
4. Source is copied into a temporary staging directory and then into a fresh Docker volume. No host source bind mount is used.
5. The model can only request verification. `RUNNING -> VERIFYING -> SUCCESS` requires the independent verifier's pass flag. Terminal state transitions are guarded. Finalization can downgrade a provisional success if final patch export fails.
6. Tool mutations and hooks execute sequentially. Operational snapshots precede edits, shell commands, and meaningful plan replacements.
7. Provider failure classification controls fallback; invalid answers and coding/test failures stay on the same model.
8. Private Git control storage is never mounted into autonomous command containers. No checkpoints affect public history.
9. Plans, accounting, results, failures, checkpoints, and recoveries are observable in traces. No private chain-of-thought is captured.
10. Failed checks, cancellation, provider outages, loops, and budget exhaustion are explicit outcomes.

## Source capture and sandbox lifecycle

```text
local Git inventory (tracked + nonignored untracked, includes dirty source)
  -> reject escaped/symlink/special paths; exclude secrets/generated paths
  -> staging copy (100 MB/file, 500 MB total)
  -> Docker workspace volume
  -> private Git input baseline
  -> optional configured bootstrap (network configurable)
  -> baseline verification
  -> autonomous action containers (network none by default)
  -> final verification and diff export
  -> container/volume cleanup
```

Input excludes `.git`, `.agent`, `.env` variants except the placeholder example, `.aws`, `.ssh`, and common dependency/build directories. Existing host credentials are not mounted. API clients and keys remain on the host; Docker receives no provider credentials or arbitrary host environment. Additional secrets embedded in ordinary source are outside the simple exclusion policy; keep them out of repositories and review artifacts.

Every command starts a short-lived container sharing only the run workspace. It has non-root UID/GID 1000, read-only root filesystem, temporary `/tmp`, resource limits, no added capabilities, and no-new-privileges. Bash runs in its own process group with a timeout and bounded pipes. The Docker container is forcibly removed afterward, including timeout/cancellation; detached grandchildren cannot persist across actions. Working files and installed workspace dependencies persist. Background services and `/tmp` state do not.

Only trusted copy/ownership/Git operations run as root. These containers drop all capabilities then add DAC_OVERRIDE and CHOWN, and Git operations alone mount a root-private checkpoint volume. They accept no model-specified arbitrary Git command. Git hooks, external diff, textconv, and fsmonitor are disabled where applicable. Docker's socket and host paths are not mounted.

Bootstrap commands originate in repository configuration read before agent edits. They may access network if allowed, but remain untrusted code in Docker. There is no proxy infrastructure; autonomous network is simply `none` or `bridge`. Enabling bridge access is explicit and increases exfiltration risk. Model requests from the host are independent of sandbox network policy.

## Plans and action loop

A full plan replacement validates item shape, unique IDs, bounds, and a single active item before assignment. Failed validation preserves the prior plan. IDs do not represent independent agents. Plan notes are public task hypotheses/progress, not private reasoning.

The runtime builds structured context, increments the turn, invokes one model, validates one action, calls MCP, observes the result, refreshes changed files/tree fingerprint, checks loops/budgets, and handles completion requests. A plan is required before edits/commands; incomplete plans cannot request completion. These constraints improve workflow consistency but do not prove correctness.

Failures in tools become bounded structured tool evidence. Invalid model responses receive at most two correction turns, with no provider switch. The loop detector rejects three identical tool/argument actions on unchanged workspace/plan state, or eight consecutive actions without meaningful state progress. All paths remain bounded by turns, tokens and time.

## Model chain and cost contract

Default fixed order: Gemini `gemini-3.8-flash`, Qwen `qwen3.7-flash`, DeepSeek `deepseek-v4-flash-0731`. Each ID has an environment override. Only these two providers exist in V1; fallback adapters never ask FreeLLMAPI to route automatically.

Each availability error gets a bounded number of runtime retries (two), with exponential delays. Missing credentials/model endpoints can move directly to the next provider; 408/429/5xx and selected connection failures are retryable. 401/403 and invalid requests stop without fallback. Invalid model JSON becomes `MODEL_RESPONSE_INVALID`, not an availability error. Gemini and OpenAI SDK internal retries are explicitly disabled.

`Retry-After` supports delay seconds and HTTP dates. The runtime waits for the larger of its exponential delay and the advertised cooldown, capped at 60 seconds; run cancellation and the wall-clock timer still interrupt that wait. Retry delays are traced as `model_retry` events. No retry parses provider prose to decide how long to wait.

Model selection is sticky after fallback. Any CLI `--model`, or `--benchmark`, disables fallback. Context uses the smallest model ceiling while fallback is enabled. Provider metadata records tokens where possible; missing metadata uses conservative estimates, including output reservation. Invalid responses retain available usage metadata. Provider errors with no usage metadata cannot reveal actual token consumption; attempts, wall time, turns, and timeouts remain hard bounded.

Free-only attestation is required before external adapters are constructed. It is a user assertion, not a provider billing API. Billing must be disabled externally; no runtime can make arbitrary API credentials free by selecting a model string.

## Verification authority

Configuration and commands are frozen from the initial source copy, so editing `.minicoder.json` or package scripts does not replace the selected command list. Package script *contents* and tests are repository code and remain editable; this is a documented V1 limitation. Trusted task-specific acceptance commands provide stronger assurance.

The verifier:

1. Audits protected names, symlinks and special files outside ignored/generated directories.
2. Validates the reversible Git diff against the runtime-owned index.
3. Refuses success when there are no meaningful configured/detected checks.
4. Runs every selected command independently in Docker, with time/resource/output limits.
5. Re-audits and revalidates after checks, since tests/builds can mutate files.
6. Returns a structured pass/fail object with exits, diagnostics, patch validity and fingerprint.

Failure is fed back to the agent while budgets remain. No model text can change the pass result. Valid patch generation is necessary but does not establish semantic task correctness. The final diff includes untracked source through the private Git index and preserves whitespace and binary diff encoding.

## Checkpoints and deterministic recovery

Private input baseline objects represent the copied source, including host uncommitted work. `git commit-tree` writes internal objects; `refs/minicoder/operational` and `refs/minicoder/validated` track the latest points. These refs live only in the disposable control volume. State retains their IDs/kinds/turns, the latest snapshot, and the currently observed Git tree fingerprint.

Operational checkpoints are inexpensive Git snapshots taken before an edit/command or plan transition. A validated checkpoint requires a meaningful independent verifier pass. A failing baseline never becomes a validated checkpoint.

After a known validated point, a failed completion check establishes a regression. Two repair cycles are allowed; the third failed check restores the validated point with `read-tree --reset -u` and cleans ordinary untracked files. File ownership is repaired for the non-root agent. Ignored dependencies/build products are retained. The runtime re-verifies restored source, refreshes changed files, and gives the agent restoration context. A restored checkpoint that no longer verifies stops the run as a sandbox failure. Ordinary intermediate test-command failures do not cause automatic rollback.

Recovery is a fixed observable policy, not a model judgment or score heuristic. Verification history is bounded in memory and complete in the trace. V1 does not reconstruct live Git checkpoint objects after process death or normal cleanup.

## Context and compaction

No raw-event history is continuously replayed. Model context contains:

- Runtime contract and generated action schema.
- Original user task and current full plan.
- Workspace/tree/checkpoint state, inspected and changed files.
- Plan notes/hypotheses and next work.
- Latest independent verification and recovery state.
- Structured compacted discoveries, commands, and unresolved failure evidence.
- Recent bounded action results.

At the soft threshold (75% including output reserve), `PreCompact` fires and older interactions move into a bounded evidence ledger. It retains beginning/end diagnostic portions, commands/arguments, unresolved errors, plan and file state. At the hard threshold (90%), recent raw results compact further; if the essential context still cannot fit, the run ends with `BUDGET_EXHAUSTED`. Important evidence may be lossy; the full retained trace is available for diagnostics, and the agent can re-read files. The original task and live plan never disappear. Provider ceilings and output reserve are configurable; fallback uses the minimum ceiling.

## Hooks and telemetry

Sequential, awaited hooks are real runtime extension points:

| Hook | V1 use |
| --- | --- |
| SessionStart | Initialize/persist run and limits |
| UserPromptSubmit | Record submitted public task |
| PreToolUse | Budget/path/command policy and tool-call trace |
| PostToolUse | Counts, output artifacts, truncation/timeouts, state publication |
| Notification | Provider fallback and restored-checkpoint notice |
| PreCompact | Record compaction lifecycle |
| Stop | Final terminal-status event |
| SessionEnd | Final terminal-status event and report persistence |

Hooks are programmatic callbacks rather than executable scripts. They run on the host and are trusted extensions. The worker enforces path/patch/shell policy again inside Docker; a hook is not the only enforcement layer.

Trace stores public actions, plans, shell exits, verifier evidence, model names/call metadata, timings, tokens, failures, checkpoints, recoveries, and compaction events. Keys/bearer material/recognizable credentials are redacted; patch export rejects known credentials instead of silently corrupting code. Files are mode 0600 and source staging is private. This is not a universal secret scanner.

`state.json` uses atomic file replacement. `events.jsonl` is append-only for diagnostics, not a fully event-sourced engine. No provider chain-of-thought, thinking parts, or reasoning-content fields are stored. `report.json` supports future evaluation without a dashboard.

## Failure, cancellation and persistence

Failure classes include `MODEL_UNAVAILABLE`, `MODEL_TRANSIENT_ERROR`, `MODEL_RESPONSE_INVALID`, `TOOL_ERROR`, `COMMAND_TIMEOUT`, `OUTPUT_TRUNCATED`, `SANDBOX_ERROR`, `LOOP_DETECTED`, `VERIFICATION_FAILED`, `BUDGET_EXHAUSTED`, `CANCELLED`, `INTERNAL_ERROR`. Some are nonterminal observations; terminal statuses preserve the underlying failure code.

External SIGINT/SIGTERM or Ink Ctrl-C aborts the same controller used for model calls, Docker subprocesses, and MCP dispatch. MCP shutdown drains in-flight tool handlers so they cannot race the terminal state write. Cleanup exports a partial patch on a separate bounded signal, records Stop/SessionEnd, persists state/report, and removes sandbox resources. Cleanup errors remain visible in trace/state. SIGKILL, host disk failure, and Docker daemon failure are outside orderly cancellation; retained source/diff/trace enable manual investigation, while orphaned volumes may require explicit user cleanup.

The basic persistent format is deliberately V1-sized. `resume`, `trace`, `eval`, durable crash reconstruction, public MCP hosting, web UI, remote Git actions and multi-agent orchestration are not implemented. Future work starts with durable resume and stronger acceptance evidence, without changing the model/runtime authority boundary.
