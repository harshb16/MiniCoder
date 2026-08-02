import { expect, test } from "bun:test";
import { renderToString } from "ink";
import { RunView } from "../src/ui/app";
import { state } from "./helpers";

test("Ink view renders all runtime fields without a terminal", () => {
  const s = state();
  s.plan = [{ id: "a", content: "Inspect repository", status: "in_progress" }];
  s.activity = ["read math.ts"];
  const output = renderToString(<RunView state={s} cancel={() => {}} interactive={false} />);
  for (const text of [
    "MiniCoder",
    "Plan",
    "Activity",
    "Inspect repository",
    "read math.ts",
    "model=",
    "turn=",
    "context=",
    "tokens=",
    "sandbox=",
    "verification=",
    "recovery=",
    "outcome=",
  ])
    expect(output).toContain(text);
});
