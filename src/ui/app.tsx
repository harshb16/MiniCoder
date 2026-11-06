import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Box, type Instance, render, Text, useInput } from "ink";
import type { ActivityEntry, RunProgress } from "../runtime/progress";
import type { RunState, Status, Verification } from "../runtime/types";

const statuses = {
  CREATED: ["Starting", "cyan"],
  RUNNING: ["Working", "cyan"],
  VERIFYING: ["Verifying", "cyan"],
  SUCCESS: ["Completed", "green"],
  FAILED: ["Failed", "red"],
  MODEL_UNAVAILABLE: ["Model unavailable", "red"],
  BUDGET_EXHAUSTED: ["Budget exhausted", "yellow"],
  CANCELLED: ["Cancelled", "yellow"],
  LOOP_DETECTED: ["Loop detected", "yellow"],
} as const satisfies Record<Status, readonly [string, string]>;

const actions = {
  bootstrap: "Set up workspace",
  baseline: "Check baseline",
  verification: "Verify candidate",
  recovery: "Restore checkpoint",
  update_plan: "Update plan",
  request_completion: "Request verification",
  edit_file: "Edit file",
  run_shell: "Run command",
  git: "Git",
  list_tree: "List files",
  tree_sitter_symbols: "Inspect symbols",
  read_file: "Read file",
  ripgrep: "Search files",
} satisfies Record<ActivityEntry["action"], string>;

function tone(color?: string): string | undefined {
  return process.env.NO_COLOR ? undefined : color;
}

function safe(text: string): string {
  return Array.from(stripVTControlCharacters(text.replace(/[\n\t]/g, " ")))
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && !(code >= 127 && code <= 159);
    })
    .join("");
}

function preview(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  return safe(first) + (first.length < text.length ? " …" : "");
}

function Activity({ entry }: { entry: ActivityEntry }) {
  const color = entry.status === "failed" ? "red" : entry.status === "running" ? "cyan" : "green";
  const mark = entry.status === "failed" ? "!" : entry.status === "running" ? "›" : "✓";
  return (
    <Text wrap="truncate-end">
      <Text color={tone(color)}>{mark}</Text>{" "}
      <Text bold={entry.status === "running"}>{actions[entry.action]}</Text>
      {entry.outcome ? <Text color={tone(color)}> · {preview(entry.outcome)}</Text> : null}
      {entry.target ? <Text dimColor> · {preview(entry.target)}</Text> : null}
    </Text>
  );
}

const verdicts = {
  passed: ["Passed", "green"],
  failed: ["Failed", "red"],
  skipped: ["Skipped", "yellow"],
  stale: ["Stale", "yellow"],
  not_configured: ["Unconfigured", undefined],
  pending: ["No result", undefined],
} as const;

function Verdict({
  label,
  status,
  detail,
}: {
  label: string;
  status: keyof typeof verdicts;
  detail?: string;
}) {
  const [title, color] = verdicts[status];
  return (
    <Box gap={1}>
      <Box width={18} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text>
          <Text bold color={tone(color)}>
            {title}
          </Text>
          {detail ? <Text dimColor> · {detail}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

function Checks({ verification }: { verification?: Verification }) {
  const trusted = verification?.trustedAcceptance;
  return (
    <>
      <Verdict
        label="Repository checks"
        status={verification?.repositoryChecks.status ?? "pending"}
      />
      <Verdict
        label="Trusted acceptance"
        status={trusted?.status ?? "pending"}
        detail={
          trusted?.status === "passed" && trusted.patchSha256
            ? "bound to final.patch"
            : trusted?.status === "failed"
              ? `case ${trusted.failedCase}`
              : undefined
        }
      />
    </>
  );
}

function Artifact({ label, path }: { label: string; path: string }) {
  return (
    <Box gap={1}>
      <Box width={6} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="hard">{safe(path)}</Text>
      </Box>
    </Box>
  );
}

export function RunView({
  state,
  progress,
  cancel,
  interactive = true,
}: {
  state: RunState;
  progress?: RunProgress;
  cancel: () => void;
  interactive?: boolean;
}) {
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") cancel();
    },
    { isActive: interactive },
  );
  const finished = Boolean(state.finishedAt);
  const [status, statusColor] = statuses[state.status];
  const entries = progress?.entries ?? [];
  const latest = entries.at(-1);
  const current = latest?.status === "running" ? latest : undefined;
  const recent = entries
    .filter(
      (entry) =>
        entry.status === "failed" ||
        (entry.status === "done" &&
          entry.action !== "update_plan" &&
          entry.action !== "request_completion"),
    )
    .slice(-4);
  const activeStep = state.plan.findIndex((item) => item.status === "in_progress");
  const planStart = Math.max(0, Math.min(activeStep - 1, state.plan.length - 4));
  const plan = state.plan.slice(planStart, planStart + 4);
  const done = state.plan.filter((item) => item.status === "done").length;
  const percent = state.context.limit
    ? Math.round((state.context.estimatedTokens / state.context.limit) * 100)
    : 0;
  const tokens = (state.usage.inputTokens + state.usage.outputTokens).toLocaleString("en-US");
  const task = safe(state.task);
  const sandbox = state.sandbox.startsWith("ready:") ? "Docker isolated" : safe(state.sandbox);
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box
        justifyContent="space-between"
        gap={1}
        borderStyle="single"
        borderColor={tone("gray")}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text bold color={tone("cyan")}>
          ◆ MiniCoder
        </Text>
        <Text bold color={tone(statusColor)}>
          {status}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{task.length > 180 ? `${task.slice(0, 179)}…` : task}</Text>
        {!finished && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>NOW</Text>
            {current ? (
              <Activity entry={current} />
            ) : (
              <Text bold color={tone("cyan")}>
                ›{" "}
                {progress?.waitingForModel
                  ? "Waiting for model"
                  : state.status === "CREATED"
                    ? "Preparing isolated workspace"
                    : "Preparing next step"}
              </Text>
            )}
          </Box>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Plan</Text>
          {state.plan.length ? (
            <Text dimColor>
              {" "}
              · {done}/{state.plan.length} complete
            </Text>
          ) : null}
        </Text>
        {planStart > 0 && <Text dimColor> … {planStart} earlier steps</Text>}
        {plan.length ? (
          plan.map((item) => {
            const active = item.status === "in_progress";
            const done = item.status === "done";
            return (
              <Text key={item.id} wrap="truncate-end" bold={active} dimColor={!active && !done}>
                <Text color={tone(active ? "cyan" : done ? "green" : undefined)}>
                  {active ? "›" : done ? "✓" : "○"}
                </Text>{" "}
                {safe(item.content)}
              </Text>
            );
          })
        ) : (
          <Text dimColor>Awaiting plan</Text>
        )}
        {planStart + plan.length < state.plan.length && (
          <Text dimColor> … {state.plan.length - planStart - plan.length} more steps</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Changes</Text>
          <Text dimColor>
            {" "}
            · {state.modified.length} {state.modified.length === 1 ? "file" : "files"}
          </Text>
        </Text>
        {state.modified.length > 0 && (
          <Text wrap="truncate-middle">
            {state.modified.slice(0, 3).map(safe).join(" · ")}
            {state.modified.length > 3 ? ` · +${state.modified.length - 3} more` : ""}
          </Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Recent activity</Text>
          {state.usage.modelCalls > 0 ? (
            <Text dimColor>
              {" "}
              · {state.usage.modelCalls} model{" "}
              {state.usage.modelCalls === 1 ? "request" : "requests"}
            </Text>
          ) : null}
        </Text>
        {recent.length ? (
          recent.map((entry, index) => <Activity key={`${entry.action}-${index}`} entry={entry} />)
        ) : (
          <Text dimColor>Waiting for first action</Text>
        )}
      </Box>
      {finished && (
        <Box
          marginTop={1}
          paddingTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor={tone("gray")}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
        >
          <Text bold>Result</Text>
          {state.failure && (
            <Text color={tone(statusColor)}>{safe(state.failure.message).slice(0, 180)}</Text>
          )}
          <Checks verification={state.verification} />
          <Box marginTop={1} flexDirection="column">
            <Artifact label="Patch" path={join(state.artifacts, "final.patch")} />
            <Artifact label="Report" path={join(state.artifacts, "report.json")} />
          </Box>
        </Box>
      )}
      <Box marginTop={1} flexWrap="wrap" columnGap={2}>
        <Text dimColor wrap="truncate-middle">
          {safe(state.model)}
        </Text>
        <Text dimColor>
          Turn {state.turn}/{state.budgets.maxTurns}
        </Text>
        <Text dimColor>Context {percent}%</Text>
        <Text dimColor>{tokens} tokens</Text>
        <Text dimColor>Sandbox {sandbox}</Text>
      </Box>
      {!finished && <Text dimColor>Ctrl-C to cancel</Text>}
    </Box>
  );
}

export function createRunDisplay(cancel: () => void) {
  let ui: Instance | undefined;
  return {
    update(state: RunState, progress: RunProgress) {
      const view = <RunView state={state} progress={progress} cancel={cancel} />;
      if (ui) ui.rerender(view);
      else ui = render(view, { exitOnCtrlC: false, maxFps: 10 });
    },
    async close() {
      if (!ui) return;
      await ui.waitUntilRenderFlush();
      ui.unmount();
      ui = undefined;
    },
  };
}
