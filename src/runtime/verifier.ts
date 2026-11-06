import type { RepoConfig } from "../config";
import type { Sandbox } from "../sandbox/docker";
import type { AcceptanceCase } from "./acceptance";
import type { Checkpoints } from "./checkpoints";
import type { Trace } from "./trace";
import { boundOutput } from "./trace";
import type { Verification } from "./types";

export interface VerificationConfig {
  commands: string[];
  source: "configured" | "detected" | "none";
}
export async function detectVerification(
  source: string,
  config: RepoConfig,
): Promise<VerificationConfig> {
  if (config.verification !== undefined)
    return { commands: [...config.verification], source: "configured" };
  const { readFile, access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const exists = async (path: string) => {
    try {
      await access(join(source, path));
      return true;
    } catch {
      return false;
    }
  };
  if (await exists("package.json")) {
    const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const manager =
      (await exists("bun.lock")) || (await exists("bun.lockb"))
        ? "bun"
        : (await exists("pnpm-lock.yaml"))
          ? "pnpm"
          : (await exists("yarn.lock"))
            ? "yarn"
            : "npm";
    const commands = ["test", "build", "lint", "typecheck"]
      .filter(
        (x) =>
          pkg.scripts?.[x] && !/no test specified|\b(?:watch|--watch)\b/.test(pkg.scripts[x] ?? ""),
      )
      .map((x) => `${manager} run ${x}`);
    return { commands, source: commands.length ? "detected" : "none" };
  }
  if (await exists("Cargo.toml")) return { commands: ["cargo test --locked"], source: "detected" };
  if (await exists("go.mod")) return { commands: ["go test ./..."], source: "detected" };
  if (await exists("pyproject.toml")) {
    const text = await readFile(join(source, "pyproject.toml"), "utf8");
    if (/\[tool\.pytest\./.test(text))
      return { commands: ["python3 -m pytest"], source: "detected" };
  }
  // Java/Gradle and ambiguous Python projects require explicit repository configuration.
  return { commands: [], source: "none" };
}
export class Verifier {
  constructor(
    private sandbox: Sandbox,
    private checkpoints: Checkpoints,
    private config: VerificationConfig,
    private trace: Trace,
    private timeoutMs: number,
    private acceptance?: AcceptanceCase[],
  ) {}
  async verify(signal: AbortSignal): Promise<Verification> {
    const errors: string[] = [];
    const commands: Verification["commands"] = [];
    const audit = (await this.sandbox.tool("audit", {}, signal)) as { violations: string[] };
    if (audit.violations.length)
      errors.push(`Workspace policy violations: ${audit.violations.join(", ")}`);
    const before = await this.checkpoints.fingerprint(signal);
    const patchValidBefore = await this.checkpoints.validPatch(signal, before);
    if (!patchValidBefore) errors.push("Final patch failed Git validation");
    if (this.config.commands.length === 0)
      errors.push("No meaningful verification commands; configure .minicoder.json verification");
    if (errors.length === 0)
      for (const command of this.config.commands) {
        const result = await this.sandbox.shell(command, this.timeoutMs, signal);
        const artifact = await this.trace.output(
          "verification",
          JSON.stringify({ command, result }),
        );
        await this.trace.event("verification_command", {
          scope: "repository",
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          artifact,
        });
        commands.push({
          command,
          result: {
            ...result,
            stdout: boundOutput(result.stdout, 8000).text,
            stderr: boundOutput(result.stderr, 8000).text,
          },
        });
        if (result.exitCode !== 0 || result.timedOut)
          errors.push(
            `${command}: ${result.timedOut ? "COMMAND_TIMEOUT" : `exit ${result.exitCode}`}`,
          );
      }
    // Tests/builds can mutate files, so audit and validate again after running them.
    const after = (await this.sandbox.tool("audit", {}, signal)) as { violations: string[] };
    if (after.violations.length)
      errors.push(`Post-verification policy violations: ${after.violations.join(", ")}`);
    const fingerprint = await this.checkpoints.fingerprint(signal);
    const patchValidAfter = await this.checkpoints.validPatch(signal, fingerprint);
    if (!patchValidAfter) errors.push("Post-verification patch invalid");
    let trustedAcceptance: Verification["trustedAcceptance"] = {
      status: this.acceptance ? "skipped" : "not_configured",
    };
    if (this.acceptance && errors.length === 0) {
      const failedCase = await this.sandbox.accept(
        fingerprint,
        this.acceptance,
        this.timeoutMs,
        signal,
      );
      if (failedCase === undefined) {
        trustedAcceptance = { status: "passed", fingerprint };
      } else {
        trustedAcceptance = { status: "failed", fingerprint, failedCase };
        errors.push(`Trusted acceptance case ${failedCase} failed`);
      }
    }
    const result: Verification = {
      passed: errors.length === 0,
      repositoryChecks: {
        status: !commands.length
          ? "skipped"
          : commands.some(({ result }) => result.exitCode !== 0 || result.timedOut)
            ? "failed"
            : "passed",
        changedCandidate: fingerprint !== before,
      },
      trustedAcceptance,
      commands,
      errors,
      patchValid: patchValidBefore && patchValidAfter,
      fingerprint,
    };
    await this.trace.event("verification", result);
    return result;
  }
}
