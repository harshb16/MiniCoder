import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState } from "./types";

export class Trace {
  private sequence = 0;
  constructor(
    public dir: string,
    private secrets: string[] = [],
  ) {}
  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets.filter((x) => x.length > 0))
      out = out.split(secret).join("<REDACTED>");
    return out
      .replace(/(Bearer\s+)[^\s"']+/gi, "$1<REDACTED>")
      .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,"'}]+/gi, "$1<REDACTED>");
  }
  async init(manifest: unknown): Promise<void> {
    await mkdir(join(this.dir, "outputs"), { recursive: true });
    await mkdir(join(this.dir, "patches"), { recursive: true });
    await this.json("manifest.json", manifest);
  }
  async json(name: string, value: unknown): Promise<void> {
    const path = join(this.dir, name);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, this.redact(JSON.stringify(value, null, 2)), { mode: 0o600 });
    await rename(tmp, path);
  }
  async event(type: string, data: unknown): Promise<void> {
    await appendFile(
      join(this.dir, "events.jsonl"),
      `${this.redact(
        JSON.stringify({ seq: ++this.sequence, time: new Date().toISOString(), type, data }),
      )}\n`,
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
