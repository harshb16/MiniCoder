import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { Config } from "../config";
import { RunError } from "../runtime/types";
import { type Action, ActionSchema, actionJsonSchema } from "./schema";

export interface ModelResult {
  action: Action;
  inputTokens: number;
  outputTokens: number;
}
export interface ModelAdapter {
  key: string;
  id: string;
  contextLimit: number;
  generate(context: string, signal: AbortSignal, maxOutputTokens: number): Promise<ModelResult>;
}
export class ProviderError extends Error {
  constructor(
    public eligible: boolean,
    public transient: boolean,
    message: string,
  ) {
    super(message);
  }
}
export function classifyProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { status?: number; code?: string; name?: string };
  const status = e?.status;
  const eligible =
    status === 404 ||
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(e?.code ?? "") ||
    ["APIConnectionError", "APIConnectionTimeoutError", "TimeoutError"].includes(e?.name ?? "") ||
    error instanceof TypeError;
  return new ProviderError(
    eligible,
    eligible && status !== 404,
    `Provider request failed${status ? ` (HTTP ${status})` : ""}`,
  );
}
function decode(text: string | undefined, inputTokens = 0, outputTokens = 0): ModelResult {
  try {
    return { action: ActionSchema.parse(JSON.parse(text ?? "")), inputTokens, outputTokens };
  } catch {
    const error = new RunError(
      "MODEL_RESPONSE_INVALID",
      "Provider returned an invalid typed action",
    );
    error.usage = { inputTokens, outputTokens };
    throw error;
  }
}
export class GeminiAdapter implements ModelAdapter {
  key = "gemini";
  private client: GoogleGenAI | undefined;
  constructor(
    public id: string,
    public contextLimit: number,
    apiKey?: string,
    private timeoutMs = 120000,
    client?: GoogleGenAI,
  ) {
    if (client) this.client = client;
    else if (apiKey) this.client = new GoogleGenAI({ apiKey, vertexai: false });
  }
  async generate(
    context: string,
    signal: AbortSignal,
    maxOutputTokens: number,
  ): Promise<ModelResult> {
    if (!this.client) throw new ProviderError(true, false, "GEMINI_API_KEY is missing");
    try {
      const response = await this.client.models.generateContent({
        model: this.id,
        contents: context,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: actionJsonSchema,
          maxOutputTokens,
          abortSignal: signal,
          httpOptions: { timeout: this.timeoutMs, retryOptions: { attempts: 1 } },
        },
      });
      return decode(
        response.text,
        response.usageMetadata?.promptTokenCount ?? Math.ceil(context.length / 4),
        response.usageMetadata?.totalTokenCount !== undefined
          ? Math.max(
              0,
              response.usageMetadata.totalTokenCount -
                (response.usageMetadata.promptTokenCount ?? 0),
            )
          : maxOutputTokens,
      );
    } catch (e) {
      if (e instanceof RunError || signal.aborted) throw e;
      throw classifyProviderError(e);
    }
  }
}
export class FreeLLMAdapter implements ModelAdapter {
  private client: OpenAI | undefined;
  constructor(
    public key: string,
    public id: string,
    public contextLimit: number,
    baseURL?: string,
    apiKey?: string,
    timeoutMs = 120000,
  ) {
    if (baseURL && apiKey) {
      const url = new URL(baseURL);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid FreeLLMAPI URL");
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Remote FreeLLMAPI requires HTTPS");
      this.client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 0 });
    }
  }
  async generate(
    context: string,
    signal: AbortSignal,
    maxOutputTokens: number,
  ): Promise<ModelResult> {
    if (!this.client) throw new ProviderError(true, false, "FreeLLMAPI configuration is missing");
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.id,
          messages: [
            {
              role: "system",
              content:
                "Return exactly one JSON tool action. Follow the runtime contract in the supplied context.",
            },
            { role: "user", content: context },
          ],
          response_format: { type: "json_object" },
          max_tokens: maxOutputTokens,
        },
        { signal },
      );
      return decode(
        response.choices[0]?.message.content ?? undefined,
        response.usage?.prompt_tokens ?? Math.ceil(context.length / 4),
        response.usage?.completion_tokens ?? maxOutputTokens,
      );
    } catch (e) {
      if (e instanceof RunError || signal.aborted) throw e;
      throw classifyProviderError(e);
    }
  }
}
export function createAdapters(config: Config, env = process.env): ModelAdapter[] {
  if (!config.freeTierConfirmed)
    throw new RunError(
      "MODEL_UNAVAILABLE",
      "Set MINICODER_FREE_TIER_CONFIRMED=true only for billing-disabled Gemini and free-only FreeLLMAPI credentials",
    );
  return config.models.map((m) =>
    m.key === "gemini"
      ? new GeminiAdapter(m.id, m.contextLimit, env.GEMINI_API_KEY, config.modelTimeoutMs)
      : new FreeLLMAdapter(
          m.key,
          m.id,
          m.contextLimit,
          env.FREELLMAPI_BASE_URL,
          env.FREELLMAPI_API_KEY,
          config.modelTimeoutMs,
        ),
  );
}
export class ModelChain {
  private index: number;
  constructor(
    private adapters: ModelAdapter[],
    private config: Pick<Config, "model" | "fallback" | "retries">,
    private notify: (
      event: string,
      data: Record<string, unknown>,
    ) => Promise<void> = async () => {},
    private sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  ) {
    this.index = adapters.findIndex((x) => x.key === config.model);
    if (this.index < 0) throw new RunError("MODEL_UNAVAILABLE", "Selected model is not configured");
  }
  get current(): ModelAdapter {
    const model = this.adapters[this.index];
    if (!model) throw new RunError("MODEL_UNAVAILABLE", "No model");
    return model;
  }
  async generate(
    context: string,
    signal: AbortSignal,
    maxOutputTokens: number,
  ): Promise<ModelResult> {
    for (;;) {
      for (let retry = 0; retry <= this.config.retries; retry++) {
        signal.throwIfAborted();
        await this.notify("model_call", { model: this.current.id, retry });
        try {
          return await this.current.generate(context, signal, maxOutputTokens);
        } catch (e) {
          if (signal.aborted || e instanceof RunError) throw e;
          const failure = classifyProviderError(e);
          await this.notify("provider_failure", {
            model: this.current.id,
            eligible: failure.eligible,
            code: failure.transient ? "MODEL_TRANSIENT_ERROR" : "MODEL_UNAVAILABLE",
            message: failure.message,
          });
          if (!failure.eligible) throw new RunError("MODEL_UNAVAILABLE", failure.message);
          if (!failure.transient || retry === this.config.retries) break;
          await this.sleep(1000 * 2 ** retry, signal);
        }
      }
      if (!this.config.fallback || this.index + 1 >= this.adapters.length)
        throw new RunError("MODEL_UNAVAILABLE", "Configured model availability exhausted");
      this.index++;
      await this.notify("model_fallback", { model: this.current.id });
      // New context limits are checked by the orchestrator before calling the fallback.
      if (Math.ceil(context.length / 3) + maxOutputTokens > this.current.contextLimit)
        throw new RunError(
          "BUDGET_EXHAUSTED",
          "Context exceeds fallback model limit; configure a smaller context budget",
        );
    }
  }
}
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
