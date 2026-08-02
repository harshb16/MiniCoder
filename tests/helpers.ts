import type { RunState } from "../src/runtime/types";
export function state(): RunState {
  return {
    id: "test",
    task: "fix",
    repo: "/repo",
    status: "CREATED",
    model: "gemini",
    turn: 0,
    plan: [],
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    budgets: { maxTurns: 3, timeoutMs: 10000, maxTokens: 10000, commandTimeoutMs: 100 },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      toolCounts: {},
      fallbackCount: 0,
      recoveryCount: 0,
    },
    context: { summary: "", estimatedTokens: 0, limit: 10000, compactions: 0 },
    checkpoints: {},
    sandbox: "idle",
    recovery: "none",
    inspected: [],
    modified: [],
    activity: [],
    artifacts: "/tmp/test",
  };
}
