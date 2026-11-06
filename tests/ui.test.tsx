import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import type { RunProgress } from "../src/runtime/progress";
import type { RunState, Verification } from "../src/runtime/types";
import { RunView } from "../src/ui/app";
import { state } from "./helpers";

function screen(state: RunState, progress?: RunProgress, columns = 88) {
  return stripVTControlCharacters(
    renderToString(
      <RunView state={state} progress={progress} cancel={() => {}} interactive={false} />,
      { columns },
    ),
  );
}

function completed(verification: Verification) {
  return {
    ...state(),
    status: verification.passed ? ("SUCCESS" as const) : ("FAILED" as const),
    finishedAt: "2026-11-06T12:00:00.000Z",
    verification,
    modified: ["src/parser.ts"],
    sandbox: "cleaned",
  };
}

const trustedPass: Verification = {
  passed: true,
  patchValid: true,
  fingerprint: "tree",
  repositoryChecks: { status: "passed", changedCandidate: false },
  trustedAcceptance: { status: "passed", fingerprint: "tree", patchSha256: "patch" },
  commands: [],
  errors: [],
};

test("shows the active plan and action with model calls grouped", () => {
  const run = state();
  run.status = "RUNNING";
  run.task = "Fix the parser";
  run.plan = [
    { id: "read", content: "Inspect the parser", status: "done" },
    { id: "fix", content: "Fix token handling", status: "in_progress" },
    { id: "test", content: "Verify the patch", status: "pending" },
  ];
  run.usage.modelCalls = 3;
  run.modified = ["src/parser.ts"];
  const output = screen(run, {
    waitingForModel: false,
    entries: [
      { action: "edit_file", target: "src/parser.ts", status: "done" },
      { action: "run_shell", target: "bun test", status: "running" },
    ],
  });
  for (const text of [
    "MiniCoder",
    "Working",
    "Fix the parser",
    "NOW",
    "› Run command · bun test",
    "✓ Inspect the parser",
    "› Fix token handling",
    "○ Verify the patch",
    "Changes · 1 file",
    "✓ Edit file · src/parser.ts",
    "3 model requests",
    "Turn 0/3",
    "Ctrl-C to cancel",
  ])
    expect(output).toContain(text);
  expect(output).not.toContain("report.json");
});

test("shows passed checks and both artifact paths for a trusted patch", () => {
  const output = screen(completed(trustedPass));
  expect(output).toContain("Completed");
  expect(output).toMatch(/Repository checks +Passed/);
  expect(output).toMatch(/Trusted acceptance +Passed · bound to final\.patch/);
  expect(output).toContain("/tmp/test/final.patch");
  expect(output).toContain("/tmp/test/report.json");
  expect(output).not.toContain("Ctrl-C");
});

test("keeps stale acceptance distinct from failure and historical recovery", () => {
  const run = completed({ ...trustedPass, passed: false, trustedAcceptance: { status: "stale" } });
  run.failure = {
    code: "VERIFICATION_FAILED",
    message: "Exported candidate differs from the accepted Git tree",
  };
  run.recovery = "old recovery message";
  const output = screen(run, {
    waitingForModel: false,
    entries: [{ action: "recovery", status: "done", outcome: "Restored" }],
  });
  expect(output).toContain("Failed");
  expect(output).toContain("Restore checkpoint · Restored");
  expect(output).toContain("Exported candidate differs");
  expect(output).toMatch(/Repository checks +Passed/);
  expect(output).toMatch(/Trusted acceptance +Stale/);
  expect(output).not.toContain(run.recovery);
  const failed = screen(
    completed({
      ...trustedPass,
      passed: false,
      trustedAcceptance: { status: "failed", fingerprint: "tree", failedCase: 2 },
    }),
  );
  expect(failed).toMatch(/Trusted acceptance +Failed · case 2/);
});

test("wraps the final panel in a narrow terminal and retains the artifact names", () => {
  const run = completed({ ...trustedPass, trustedAcceptance: { status: "not_configured" } });
  run.task = "Fix the very long token stream that contains another long identifier";
  run.model = "deterministic-fixture-with-a-long-name";
  run.artifacts = "/tmp/minicoder/a-long-run-id-for-a-narrow-terminal";
  const output = screen(
    run,
    {
      waitingForModel: false,
      entries: [
        {
          action: "run_shell",
          target: "bun test\nsecond line should be hidden",
          status: "done",
          outcome: "Exit 0",
        },
      ],
    },
    42,
  );
  expect(output).toContain("Unconfigured");
  expect(output).toContain("Repository checks");
  expect(output).toContain("final.patch");
  expect(output).toContain("report.json");
  expect(output).toContain("bun test");
  expect(output).not.toContain("second line");
  for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(42);
});
