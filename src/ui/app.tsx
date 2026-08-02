import { stripVTControlCharacters } from "node:util";
import { Box, Text, useInput } from "ink";
import type { RunState } from "../runtime/types";

function safe(text: string): string {
  return Array.from(stripVTControlCharacters(text))
    .filter((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) || c === "\n" || c === "\t")
    .join("");
}
export function RunView({
  state,
  cancel,
  interactive = true,
}: {
  state: RunState;
  cancel: () => void;
  interactive?: boolean;
}) {
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") cancel();
    },
    { isActive: interactive },
  );
  const percent = state.context.limit
    ? Math.round((state.context.estimatedTokens / state.context.limit) * 100)
    : 0;
  return (
    <Box flexDirection="column">
      <Text bold>MiniCoder / {state.id}</Text>
      <Text>{safe(state.task).slice(0, 300)}</Text>
      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <Text bold>Plan</Text>
        {state.plan.length === 0 ? (
          <Text dimColor>Awaiting plan</Text>
        ) : (
          state.plan.map((item) => (
            <Text key={item.id}>
              {item.status === "done" ? "✓" : item.status === "in_progress" ? "→" : "○"}{" "}
              {safe(item.content)}
            </Text>
          ))
        )}
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <Text bold>Activity</Text>
        {state.activity.map((item, i) => (
          <Text key={`${i}-${item}`}>{safe(item)}</Text>
        ))}
      </Box>
      <Text>
        model={state.model} turn={state.turn}/{state.budgets.maxTurns} context={percent}% tokens=
        {state.usage.inputTokens + state.usage.outputTokens}
      </Text>
      <Text>sandbox={state.sandbox}</Text>
      <Text>
        verification=
        {state.status === "VERIFYING"
          ? "running"
          : state.verification
            ? state.verification.passed
              ? "passed"
              : "failed"
            : "pending"}{" "}
        recovery={state.recovery}
      </Text>
      <Text bold>outcome={state.status}</Text>
      {state.failure ? (
        <Text color="red">
          {safe(state.failure.code)}: {safe(state.failure.message)}
        </Text>
      ) : null}
      <Text dimColor>Artifacts: {state.artifacts}</Text>
      {["RUNNING", "CREATED", "VERIFYING"].includes(state.status) ? (
        <Text dimColor>Ctrl-C to cancel and export partial work</Text>
      ) : null}
    </Box>
  );
}
