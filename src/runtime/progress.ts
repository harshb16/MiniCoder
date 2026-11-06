import type { ToolName } from "../models/schema";

export type ActivityAction = ToolName | "bootstrap" | "baseline" | "verification" | "recovery";

export interface ActivityEntry {
  action: ActivityAction;
  target?: string;
  status: "running" | "done" | "failed";
  outcome?: string;
}

// Transient display data. The state file and JSONL events retain their existing format.
export interface RunProgress {
  waitingForModel: boolean;
  entries: ActivityEntry[];
}
