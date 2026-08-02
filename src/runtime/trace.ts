import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState } from "./types";

export class Trace {
  private sequence = 0;
  constructor(
    public dir: string,
    private secrets: string[] = [],
  ) {}
  containsSecret(text: string): boolean {
    return (
      this.secrets.some((secret) => secret.length > 0 && text.includes(secret)) ||
      /AIza[\w-]{30,}|\bsk-[A-Za-z0-9_-]{30,}/.test(text)
    );
  }
  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets.filter((x) => x.length > 0))
      out = out.split(secret).join("<REDACTED>");
    return out
      .replace(/(Bearer\s+)[^\s"']+/gi, "$1<REDACTED>")
      .replace(/AIza[\w-]{30,}|\bsk-[A-Za-z0-9_-]{30,}/g, "<REDACTED>");
  }
  private serialize(value: unknown, pretty = false): string {
    return this.redact(
      JSON.stringify(
        value,
        (key, entry) =>
          /^(?:api[_-]?key|password|secret|access[_-]?token)$/i.test(key) &&
          typeof entry === "string"
            ? "<REDACTED>"
            : entry,
        pretty ? 2 : undefined,
      ),
    );
  }
  async patch(turn: number, patch: string): Promise<void> {
    if (this.containsSecret(patch))
      throw new Error("Credential material rejected from patch artifacts");
    await writeFile(join(this.dir, "patches", `${turn}.patch`), patch, { mode: 0o600 });
  }
  async finalPatch(patch: string): Promise<void> {
    if (this.containsSecret(patch))
      throw new Error("Credential material rejected from final patch");
    await writeFile(join(this.dir, "final.patch"), patch, { mode: 0o600 });
  }
  async init(manifest: unknown): Promise<void> {
    await mkdir(join(this.dir, "outputs"), { recursive: true });
    await mkdir(join(this.dir, "patches"), { recursive: true });
    await this.json("manifest.json", manifest);
  }
  async json(name: string, value: unknown): Promise<void> {
    const path = join(this.dir, name);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, this.serialize(value, true), { mode: 0o600 });
    await rename(tmp, path);
  }
  async event(type: string, data: unknown): Promise<void> {
    await appendFile(
      join(this.dir, "events.jsonl"),
      `${this.serialize({ seq: ++this.sequence, time: new Date().toISOString(), type, data })}\n`,
      { mode: 0o600 },
    );
  }
  async output(label: string, value: string): Promise<string> {
    const name = `outputs/${this.sequence}-${label.replace(/[^a-z0-9_-]/gi, "_")}.txt`;
    await writeFile(join(this.dir, name), this.redact(value), { mode: 0o600 });
    return name;
  }
  async save(state: RunState): Promise<void> {
    await this.json("state.json", state);
  }
}
export function boundOutput(value: string, maxChars = 16000): { text: string; omitted: number } {
  if (value.length <= maxChars) return { text: value, omitted: 0 };
  const reserve = 160;
  const head = Math.floor((maxChars - reserve) * 0.65);
  const tail = maxChars - reserve - head;
  const omitted = value.length - head - tail;
  return {
    text: `${value.slice(0, head)}\n[OUTPUT_TRUNCATED: ${omitted} characters omitted; use narrower reads/search. Raw output retained in artifacts.]\n${value.slice(-tail)}`,
    omitted,
  };
}
