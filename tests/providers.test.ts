import { expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "../src/config";
import { createAdapters, FreeLLMAdapter, GeminiAdapter, ModelChain } from "../src/models/adapters";
import { RunError } from "../src/runtime/types";

const action = { tool: "read_file" as const, arguments: { path: "math.ts" } };
test("official Gemini SDK sends structured schema and decodes action and usage", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      requests.push(await req.json());
      return Response.json({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(action) }], role: "model" },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 33 },
      });
    },
  });
  try {
    const sdk = new GoogleGenAI({
      apiKey: "dummy-test-key",
      httpOptions: { baseUrl: `http://127.0.0.1:${server.port}` },
    });
    const adapter = new GeminiAdapter("gemini-3.8-flash", 32000, undefined, 1000, sdk);
    const result = await adapter.generate("context", new AbortController().signal, 100);
    expect(result.action).toEqual(action);
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(13);
    const cfg = requests[0]?.generationConfig as {
      responseMimeType: string;
      responseJsonSchema: { anyOf: unknown[] };
    };
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseJsonSchema.anyOf.length).toBe(9);
  } finally {
    server.stop(true);
  }
});
test("generic FreeLLMAPI adapter pins exact IDs with no automatic routing", async () => {
  const models: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = await req.json();
      models.push(body.model);
      expect(body.response_format.type).toBe("json_object");
      return Response.json({
        id: "test",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(action) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      });
    },
  });
  try {
    for (const [key, id] of [
      ["kimi", "kimi-k2.7-code"],
      ["deepseek", "deepseek-v4-flash"],
    ]) {
      const a = new FreeLLMAdapter(
        key ?? "",
        id ?? "",
        32000,
        `http://127.0.0.1:${server.port}/v1`,
        "dummy",
        1000,
      );
      const r = await a.generate("context", new AbortController().signal, 100);
      expect(r.action).toEqual(action);
      expect(r.inputTokens).toBe(12);
    }
    expect(models).toEqual(["kimi-k2.7-code", "deepseek-v4-flash"]);
  } finally {
    server.stop(true);
  }
});
test("HTTP availability fallback order is exact and SDK retries are disabled", async () => {
  const ids: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = await req.json();
      ids.push(body.model);
      if (body.model === "kimi-k2.7-code")
        return Response.json({ error: { message: "quota" } }, { status: 429 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(action) } }] });
    },
  });
  try {
    const unavailable = {
      key: "gemini",
      id: "gemini-3.8-flash",
      contextLimit: 32000,
      generate: async () => {
        throw { status: 503 };
      },
    };
    const chain = new ModelChain(
      [
        unavailable,
        new FreeLLMAdapter(
          "kimi",
          "kimi-k2.7-code",
          32000,
          `http://127.0.0.1:${server.port}/v1`,
          "dummy",
          1000,
        ),
        new FreeLLMAdapter(
          "deepseek",
          "deepseek-v4-flash",
          32000,
          `http://127.0.0.1:${server.port}/v1`,
          "dummy",
          1000,
        ),
      ],
      { model: "gemini", fallback: true, retries: 1 },
      undefined,
      async () => {},
    );
    expect((await chain.generate("context", new AbortController().signal, 100)).action).toEqual(
      action,
    );
    expect(ids).toEqual(["kimi-k2.7-code", "kimi-k2.7-code", "deepseek-v4-flash"]);
  } finally {
    server.stop(true);
  }
});
test("invalid model answer does not trigger fallback", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ choices: [{ message: { content: "not an action" } }] }),
  });
  let fallbackCalled = false;
  try {
    const a = new FreeLLMAdapter(
      "kimi",
      "kimi-k2.7-code",
      32000,
      `http://127.0.0.1:${server.port}/v1`,
      "dummy",
      1000,
    );
    const chain = new ModelChain(
      [
        a,
        {
          key: "deepseek",
          id: "deepseek-v4-flash",
          contextLimit: 32000,
          generate: async () => {
            fallbackCalled = true;
            throw new Error("unexpected");
          },
        },
      ],
      { model: "kimi", fallback: true, retries: 2 },
    );
    try {
      await chain.generate("context", new AbortController().signal, 100);
      throw new Error("expected invalid response");
    } catch (e) {
      expect(e).toBeInstanceOf(RunError);
      expect((e as RunError).code).toBe("MODEL_RESPONSE_INVALID");
    }
    expect(fallbackCalled).toBe(false);
  } finally {
    server.stop(true);
  }
});
test("free-only setup refuses inference without attestation", () => {
  expect(() => createAdapters(loadConfig({}), {})).toThrow("billing-disabled");
});
