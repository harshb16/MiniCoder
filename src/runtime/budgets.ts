import type { RunState } from "./types";
import { RunError } from "./types";
export class Budgets {
  constructor(
    private state: RunState,
    private now: () => number = Date.now,
  ) {}
  check(signal: AbortSignal, modelTurn = false): void {
    if (signal.aborted)
      throw signal.reason instanceof RunError
        ? signal.reason
        : new RunError("CANCELLED", "Run cancelled");
    if (
      this.now() - Date.parse(this.state.startedAt) >= this.state.budgets.timeoutMs ||
      this.state.usage.inputTokens + this.state.usage.outputTokens >=
        this.state.budgets.maxTokens ||
      (modelTurn && this.state.turn >= this.state.budgets.maxTurns)
    )
      throw new RunError("BUDGET_EXHAUSTED", "Runtime budget exhausted");
  }
}
export class LoopDetector {
  private history: { key: string; fingerprint: string }[] = [];
  observe(tool: string, args: unknown, fingerprint: string): void {
    const key = JSON.stringify([tool, args]);
    this.history.push({ key, fingerprint });
    this.history = this.history.slice(-8);
    if (
      this.history.filter((x) => x.key === key && x.fingerprint === fingerprint).length >= 3 ||
      (this.history.length === 8 && this.history.every((x) => x.fingerprint === fingerprint))
    )
      throw new RunError(
        "LOOP_DETECTED",
        "Repeated actions without meaningful workspace or plan progress",
      );
  }
}
