import { z } from "zod";

export const RepoConfigSchema = z
  .object({
    bootstrap: z.array(z.string().min(1).max(4000)).max(10).default([]),
    verification: z.array(z.string().min(1).max(4000)).max(20).optional(),
  })
  .strict();
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export interface Config {
  maxTurns: number;
  timeoutMs: number;
  commandTimeoutMs: number;
  maxTokens: number;
  modelTimeoutMs: number;
  retries: number;
  outputChars: number;
  network: boolean;
  bootstrapNetwork: boolean;
  image: string;
  fallback: boolean;
  model: "gemini" | "kimi" | "deepseek";
  freeTierConfirmed: boolean;
  models: { key: "gemini" | "kimi" | "deepseek"; id: string; contextLimit: number }[];
}
function positive(value: string | undefined, defaultValue: number): number {
  const n = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("Configuration limits must be positive integers");
  return n;
}
export function loadConfig(env = process.env, overrides: Partial<Config> = {}): Config {
  if (env.MINICODER_FREE_ONLY === "false")
    throw new Error("MiniCoder V1 requires free-only inference");
  const c: Config = {
    maxTurns: positive(env.MINICODER_MAX_TURNS, 50),
    timeoutMs: positive(env.MINICODER_TIMEOUT_MS, 900000),
    commandTimeoutMs: positive(env.MINICODER_COMMAND_TIMEOUT_MS, 60000),
    maxTokens: positive(env.MINICODER_MAX_TOKENS, 2000000),
    modelTimeoutMs: positive(env.MINICODER_MODEL_TIMEOUT_MS, 120000),
    retries: 2,
    outputChars: 16000,
    network: false,
    bootstrapNetwork: env.MINICODER_BOOTSTRAP_NETWORK !== "false",
    image: env.MINICODER_SANDBOX_IMAGE || "minicoder-sandbox:v1",
    fallback: true,
    model: "gemini",
    freeTierConfirmed: env.MINICODER_FREE_TIER_CONFIRMED === "true",
    models: [
      {
        key: "gemini",
        id: env.GEMINI_MODEL || "gemini-3.8-flash",
        contextLimit: positive(env.GEMINI_CONTEXT_LIMIT, 1048576),
      },
      {
        key: "kimi",
        id: env.FREELLMAPI_KIMI_MODEL || "kimi-k2.7-code",
        contextLimit: positive(env.KIMI_CONTEXT_LIMIT, 262144),
      },
      {
        key: "deepseek",
        id: env.FREELLMAPI_DEEPSEEK_MODEL || "deepseek-v4-flash",
        contextLimit: positive(env.DEEPSEEK_CONTEXT_LIMIT, 1048576),
      },
    ],
    ...overrides,
  };
  for (const n of [
    c.maxTurns,
    c.timeoutMs,
    c.commandTimeoutMs,
    c.maxTokens,
    c.modelTimeoutMs,
    c.outputChars,
  ])
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid runtime limit");
  if (!["gemini", "kimi", "deepseek"].includes(c.model))
    throw new Error("Unsupported model selector");
  if (c.model !== "gemini") c.fallback = false;
  return c;
}
