import type { Checkpoint, Verification } from "./types";

export class RecoveryPolicy {
  private failures = 0;
  private lastFingerprint = "";
  history: { passed: boolean; fingerprint: string; errors: string[] }[] = [];
  constructor(private repairAttempts = 2) {}
  observe(result: Verification, validated?: Checkpoint): "continue" | "restore" {
    this.history.push({
      passed: result.passed,
      fingerprint: result.fingerprint,
      errors: result.errors,
    });
    this.history = this.history.slice(-20);
    if (result.passed) {
      this.failures = 0;
      this.lastFingerprint = result.fingerprint;
      return "continue";
    }
    if (!validated) return "continue";
    // Any failure after a validated checkpoint is a measurable regression.
    // Give two completion/verification repair cycles before restoring. Ordinary shell failures do not rollback.
    this.failures++;
    this.lastFingerprint = result.fingerprint;
    if (this.failures > this.repairAttempts) {
      this.failures = 0;
      return "restore";
    }
    return "continue";
  }
  get fingerprint(): string {
    return this.lastFingerprint;
  }
}
