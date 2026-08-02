import { expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "../src/config";
import {
  classifyProviderError,
  createAdapters,
  FreeLLMAdapter,
  GeminiAdapter,
  ModelChain,
  retryAfter,
} from "../src/models/adapters";
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
      ["qwen", "qwen3.7-flash"],
      ["deepseek", "deepseek-v4-flash-0731"],
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
    expect(models).toEqual(["qwen3.7-flash", "deepseek-v4-flash-0731"]);
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
      if (body.model === "qwen3.7-flash")
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
          "qwen",
          "qwen3.7-flash",
          32000,
          `http://127.0.0.1:${server.port}/v1`,
          "dummy",
          1000,
        ),
        new FreeLLMAdapter(
          "deepseek",
          "deepseek-v4-flash-0731",
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
    expect(ids).toEqual(["qwen3.7-flash", "qwen3.7-flash", "deepseek-v4-flash-0731"]);
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
      "qwen",
      "qwen3.7-flash",
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
          id: "deepseek-v4-flash-0731",
          contextLimit: 32000,
          generate: async () => {
            fallbackCalled = true;
            throw new Error("unexpected");
          },
        },
      ],
      { model: "qwen", fallback: true, retries: 2 },
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

test("Retry-After accepts seconds and HTTP dates with a bounded delay", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  expect(retryAfter("45", now)).toBe(45000);
  expect(retryAfter("Sun, 02 Aug 2026 12:00:30 GMT", now)).toBe(30000);
  expect(retryAfter("999999", now)).toBe(60000);
  for (const value of [undefined, "", " ", "-1", "invalid", "NaN", "Infinity"])
    expect(retryAfter(value, now)).toBeUndefined();
  expect(retryAfter("Sun, 02 Aug 2026 11:59:00 GMT", now)).toBeUndefined();
});

test("provider cooldown is honored before bounded retry without switching models", async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const headers = new Headers({ "retry-after": "45" });
  const error = classifyProviderError({ status: 429, headers });
  expect(error.retryAfterMs).toBe(45000);
  const model = {
    key: "qwen",
    id: "qwen3.7-flash",
    contextLimit: 32000,
    generate: async () => {
      calls.push("qwen");
      if (calls.length === 1) throw error;
      return { action, inputTokens: 12, outputTokens: 5 };
    },
  };
  const chain = new ModelChain(
    [model],
    { model: "qwen", fallback: false, retries: 2 },
    undefined,
    async (ms) => {
      delays.push(ms);
    },
  );
  expect((await chain.generate("context", new AbortController().signal, 100)).action).toEqual(
    action,
  );
  expect(calls).toEqual(["qwen", "qwen"]);
  expect(delays).toEqual([45000]);
});

test("cancellation interrupts a provider cooldown before another request", async () => {
  const ac = new AbortController();
  let calls = 0;
  const chain = new ModelChain(
    [
      {
        key: "qwen",
        id: "qwen3.7-flash",
        contextLimit: 32000,
        generate: async () => {
          calls++;
          throw classifyProviderError({
            status: 429,
            headers: new Headers({ "retry-after": "45" }),
          });
        },
      },
    ],
    { model: "qwen", fallback: false, retries: 2 },
    async (event) => {
      if (event === "model_retry") ac.abort();
    },
  );
  await expect(chain.generate("context", ac.signal, 100)).rejects.toThrow();
  expect(calls).toBe(1);
});
