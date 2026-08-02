import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Action, type ToolName, toolSchemas } from "../models/schema";
import type { Hooks } from "../runtime/hooks";
import { boundOutput, type Trace } from "../runtime/trace";
import { RunError } from "../runtime/types";

export interface ToolExecutor {
  execute(name: ToolName, args: Record<string, unknown>): Promise<unknown>;
}
export class McpTools {
  private token = randomUUID();
  private inFlight = new Set<Promise<void>>();
  private http?: ReturnType<typeof createServer>;
  private server = new McpServer({ name: "MiniCoder tools", version: "1.0.0" });
  private transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  private client = new Client({ name: "MiniCoder agent", version: "1.0.0" });
  constructor(
    private executor: ToolExecutor,
    private hooks: Hooks,
    private trace: Trace,
    private outputChars = 16000,
  ) {}
  async start(): Promise<void> {
    for (const name of Object.keys(toolSchemas) as ToolName[]) {
      this.server.registerTool(
        name,
        { description: `MiniCoder ${name}`, inputSchema: toolSchemas[name].shape },
        async (args: Record<string, unknown>) => {
          let finished: () => void = () => {};
          const done = new Promise<void>((resolve) => {
            finished = resolve;
          });
          this.inFlight.add(done);
          try {
            let value: unknown;
            let failed = false;
            try {
              const parsed = toolSchemas[name].parse(args);
              await this.hooks.emit("PreToolUse", { tool: name, arguments: parsed });
              value = await this.executor.execute(name, parsed);
            } catch (e) {
              failed = true;
              value = {
                error: e instanceof RunError ? e.code : "TOOL_ERROR",
                message: e instanceof Error ? e.message : "Tool failed",
              };
            }
            const raw = this.trace.redact(JSON.stringify(value));
            const artifact = await this.trace.output(name, raw);
            const bounded = boundOutput(raw, this.outputChars);
            await this.hooks.emit("PostToolUse", {
              tool: name,
              failed,
              omitted: bounded.omitted,
              artifact,
              result: value,
            });
            if (bounded.omitted)
              await this.trace.event("failure", {
                code: "OUTPUT_TRUNCATED",
                tool: name,
                omitted: bounded.omitted,
                artifact,
              });
            return { content: [{ type: "text" as const, text: bounded.text }], isError: failed };
          } finally {
            finished();
            this.inFlight.delete(done);
          }
        },
      );
    }
    await this.server.connect(this.transport);
    this.http = createServer((req, res) => {
      if (
        req.url !== "/mcp" ||
        req.headers.authorization !== `Bearer ${this.token}` ||
        req.headers.origin
      ) {
        res.writeHead(403).end();
        return;
      }
      // Bound the request before SDK parsing. No unauthenticated tool access.
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2000000) {
          res.writeHead(413).end();
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => {
        let body: unknown;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        } catch {
          res.writeHead(400).end();
          return;
        }
        this.transport.handleRequest(req, res, body).catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.http?.once("error", reject);
      this.http?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.http.address();
    if (!address || typeof address === "string")
      throw new RunError("INTERNAL_ERROR", "MCP endpoint unavailable");
    await this.client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
      }),
    );
  }
  async call(action: Action, signal?: AbortSignal): Promise<{ output: string; failed: boolean }> {
    const result = await this.client.callTool(
      { name: action.tool, arguments: action.arguments },
      undefined,
      { signal, timeout: 360000 },
    );
    const content = result.content as { type: string; text?: string }[];
    return {
      output: content
        .filter((x) => x.type === "text")
        .map((x) => x.text ?? "")
        .join("\n"),
      failed: result.isError === true,
    };
  }
  async list(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((x) => x.name);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    await this.client.close();
    await this.server.close();
    if (this.http) {
      this.http.closeAllConnections();
      await new Promise<void>((resolve) => this.http?.close(() => resolve()));
    }
  }
}
