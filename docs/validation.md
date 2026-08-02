# V1 validation

The implementation is exercised with deterministic models and actual local Docker/MCP infrastructure. No external credentials are required for default tests.

## Reproducible checks

```bash
bun install --frozen-lockfile
bun run sandbox:build
bun run typecheck
bun run lint
bun test
MINICODER_DOCKER_TESTS=1 bun test
bun run smoke
bun run check:secrets
PATH="$PWD/bin:$PATH" agent --help
```

Default tests cover plan schema/atomic replacement; path canonicalization, traversal and symlink restrictions; command protection/timeouts; output bounds; hard budgets; fallback eligibility/order/pinning; model response validation; official SDK request/usage parsing against local HTTP servers; success transitions; independent verification; checkpoint metadata; regression recovery; repeated actions; JSONL/redaction; context compaction; Ink rendering; MCP cancellation/draining; finalization; and whitespace-safe diff export.

Docker integration adds real tree-sitter symbols, ripgrep, unified patches, non-root/no-network execution, timeout cleanup, host preservation, independent tests, validated checkpoint restore, and successful edits after restore. The fixture smoke uses nine actions through the real agent loop and MCP transport. It fixes subtraction to addition, tests independently, exports a Git-applicable patch, verifies source preservation, and checks trace events. It is not a model benchmark.

Final local results: typecheck and lint passed; 38 tests passed with Docker enabled (36 default tests plus 2 opt-in Docker tests), with no failures. The rebuilt-image fixture smoke returned `SUCCESS` in nine turns with a valid exported patch and unchanged original source. The Git secret audit passed. These counts describe the validation at the V1 implementation milestone, not a benchmark.

## Initial live provider observations

Live calls were separately opted in after free-only credentials were confirmed. No credential values or private reasoning were printed or committed.

- Gemini `gemini-3.8-flash` accepted the official SDK's structured schema and returned valid plan, read, and edit actions on the tiny fixture. A pinned run encountered repeated HTTP 503 responses and terminated as `MODEL_UNAVAILABLE` before final verification. This demonstrates the adapter/action path but does not establish a completed live Gemini smoke run.
- FreeLLMAPI `kimi-k2.7-code` and `deepseek-v4-flash` were called with explicit IDs. Both endpoint/model requests returned HTTP 503 during pinned tests; neither pinned test changed models.
- A controlled availability test omitted the Gemini credential, selected Kimi, then DeepSeek after bounded retries, and ended with `MODEL_UNAVAILABLE` and two recorded fallback transitions. Provider unavailability was never treated as successful coding.
- Some live setup attempts received Docker's missing-image response; direct inspection and subsequent Docker integration/fixture runs succeeded. The final image is built locally from the repository. `bun run sandbox:build` is the recovery step if a selected Docker context lacks the image.

The SDK/compatible HTTP protocols and fallback policy pass local deterministic tests. Completed live inference runs remain subject to provider availability and quotas; V1 does not claim these unavailable live tests passed. Retry with:

```bash
MINICODER_FREE_TIER_CONFIRMED=true bun scripts/live-smoke.ts gemini
MINICODER_FREE_TIER_CONFIRMED=true bun scripts/live-smoke.ts qwen
MINICODER_FREE_TIER_CONFIRMED=true bun scripts/live-smoke.ts deepseek
MINICODER_FREE_TIER_CONFIRMED=true bun scripts/live-smoke.ts fallback
```

Each prints a retained diagnostic/artifact path and checks original source preservation. No unsupported performance or task-success benchmark is reported.

## FreeLLMAPI model refresh

The default fallback models are now Qwen `qwen3.7-flash` followed by DeepSeek `deepseek-v4-flash-0731`. Gemini remains first. Model selection, environment overrides, pinned evaluation behavior, and the generic OpenAI-compatible adapter are unchanged. `--model qwen`, `FREELLMAPI_QWEN_MODEL`, and `QWEN_CONTEXT_LIMIT` replace the former Kimi settings.

The configured endpoint's model inventory advertised both IDs. The supplied display-style identifier `deepseek/deepseek-v4-flash-0731free` returned HTTP 404, so the configured default uses the advertised DeepSeek ID instead. No automatic model routing or identifier rewriting was introduced.

The refreshed image passed typecheck, lint, all 42 tests including Docker integration, and the deterministic nine-turn smoke test with a valid patch and unchanged input repository. Additional tests cover bounded provider cooldowns and cancellation, patches without a terminating newline, and preservation of target-file newline markers.

Initial live refresh checks:

- Qwen returned a valid typed `read_file` action and token usage during a minimal adapter probe. Its pinned coding fixture then exhausted retries on HTTP 429. A diagnostic request reported that its route was rate-limited or on cooldown.
- The advertised DeepSeek ID exhausted the pinned fixture's availability retries on HTTP 503. A diagnostic request reported: "No candidate model has a configured, usable provider key." The FreeLLMAPI access key authenticates requests, but an upstream provider key must also be configured in that endpoint's dashboard.
- Both fixture repositories remained unchanged, neither pinned run fell back, and diagnostic artifacts were retained. These failed live runs are not reported as successful end-to-end coding.

Live integration exposed two compatibility fixes. The endpoint's HTTP 429 responses advertise `Retry-After`, which the runtime now honors within its retry/wall-clock bounds. Qwen also emitted unified patches without a terminating newline; the worker now adds only that diff terminator before Git validation, retaining file newline markers and all path/header restrictions. A pre-fix fixture ended with `LOOP_DETECTED` after repeated corrupt-patch failures, and was not considered successful.

The final Qwen fixture used the rebuilt worker and a 15-minute wall-clock budget. It returned valid read/edit actions, was correctly refused an edit before creating a plan, then exhausted its two availability retries on HTTP 429 despite advertised cooldown waits of 60 and 30 seconds. It terminated as `MODEL_UNAVAILABLE` at turn 3 with no fallback and unchanged input source. No completed live Qwen or refreshed DeepSeek coding fixture is claimed. Resolve the endpoint's route quotas/cooldowns and configure a usable upstream key for DeepSeek, then rerun the pinned smoke commands above; the longer Qwen command is:

```bash
MINICODER_TIMEOUT_MS=900000 MINICODER_FREE_TIER_CONFIRMED=true bun scripts/live-smoke.ts qwen
```
