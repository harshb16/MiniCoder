import { z } from "zod";

export const PlanSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(80),
        content: z.string().min(1).max(500),
        status: z.enum(["pending", "in_progress", "done"]),
        notes: z.string().max(1000).optional(),
      })
      .strict(),
  )
  .max(30)
  .superRefine((items, ctx) => {
    if (new Set(items.map((x) => x.id)).size !== items.length)
      ctx.addIssue({ code: "custom", message: "Plan IDs must be unique" });
    if (items.filter((x) => x.status === "in_progress").length > 1)
      ctx.addIssue({ code: "custom", message: "At most one plan item may be in progress" });
  });
export type Plan = z.infer<typeof PlanSchema>;
export type FailureCode =
  | "MODEL_UNAVAILABLE"
  | "MODEL_TRANSIENT_ERROR"
  | "MODEL_RESPONSE_INVALID"
  | "TOOL_ERROR"
  | "COMMAND_TIMEOUT"
  | "OUTPUT_TRUNCATED"
  | "SANDBOX_ERROR"
  | "LOOP_DETECTED"
  | "VERIFICATION_FAILED"
  | "BUDGET_EXHAUSTED"
  | "CANCELLED"
  | "INTERNAL_ERROR";
export type Status =
  | "CREATED"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCESS"
  | "FAILED"
  | "MODEL_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "CANCELLED"
  | "LOOP_DETECTED";
export class RunError extends Error {
  usage?: { inputTokens: number; outputTokens: number };
  constructor(
    public code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  omittedBytes: number;
}
export interface Checkpoint {
  id: string;
  kind: "operational" | "validated";
  turn: number;
}
export interface Verification {
  passed: boolean;
  commands: { command: string; result: CommandResult }[];
  errors: string[];
  patchValid: boolean;
  fingerprint: string;
}
export interface RunState {
  id: string;
  task: string;
  repo: string;
  status: Status;
  model: string;
  turn: number;
  plan: Plan;
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  budgets: { maxTurns: number; timeoutMs: number; maxTokens: number; commandTimeoutMs: number };
  usage: {
    inputTokens: number;
    outputTokens: number;
    modelCalls: number;
    toolCounts: Record<string, number>;
    fallbackCount: number;
    recoveryCount: number;
  };
  context: { summary: string; estimatedTokens: number; limit: number; compactions: number };
  checkpoints: {
    operational?: Checkpoint;
    validated?: Checkpoint;
    current?: string;
    currentTree?: string;
  };
  verification?: Verification;
  sandbox: string;
  recovery: string;
  inspected: string[];
  modified: string[];
  activity: string[];
  artifacts: string;
  failure?: { code: FailureCode; message: string };
}
export function replacePlan(state: RunState, value: unknown): void {
  state.plan = PlanSchema.parse(value);
}
export function transition(state: RunState, next: Status, verifierPassed = false): void {
  const terminal = [
    "SUCCESS",
    "FAILED",
    "MODEL_UNAVAILABLE",
    "BUDGET_EXHAUSTED",
    "CANCELLED",
    "LOOP_DETECTED",
  ];
  if (terminal.includes(state.status))
    throw new RunError("INTERNAL_ERROR", "Terminal state is immutable");
  if (next === "SUCCESS" && (state.status !== "VERIFYING" || !verifierPassed))
    throw new RunError("INTERNAL_ERROR", "Only verifier may authorize success");
  if (next === "VERIFYING" && state.status !== "RUNNING")
    throw new RunError("INTERNAL_ERROR", "Invalid verification transition");
  if (next === "RUNNING" && !["CREATED", "VERIFYING"].includes(state.status))
    throw new RunError("INTERNAL_ERROR", "Invalid running transition");
  state.status = next;
}
