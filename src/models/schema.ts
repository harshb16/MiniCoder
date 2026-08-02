import { z } from "zod";
import { PlanSchema } from "../runtime/types";
export const toolSchemas = {
  list_tree: z
    .object({
      path: z.string().default("."),
      maxEntries: z.number().int().min(1).max(500).default(200),
    })
    .strict(),
  read_file: z
    .object({
      path: z.string(),
      startLine: z.number().int().min(1).default(1),
      endLine: z.number().int().min(1).default(200),
    })
    .strict(),
  ripgrep: z
    .object({
      pattern: z.string().max(2000),
      path: z.string().default("."),
      maxMatches: z.number().int().min(1).max(300).default(100),
    })
    .strict(),
  tree_sitter_symbols: z.object({ path: z.string() }).strict(),
  edit_file: z.object({ path: z.string(), patch: z.string().max(100000) }).strict(),
  run_shell: z
    .object({
      command: z.string().min(1).max(8000),
      cwd: z.string().default("."),
      timeoutMs: z.number().int().min(1).max(300000).optional(),
    })
    .strict(),
  git: z
    .object({
      operation: z.enum(["status", "diff", "log", "show"]),
      revision: z
        .string()
        .regex(/^[a-zA-Z0-9~^_./-]{1,100}$/)
        .optional(),
    })
    .strict(),
  update_plan: z.object({ plan: PlanSchema }).strict(),
  request_completion: z.object({ summary: z.string().min(1).max(2000) }).strict(),
};
export type ToolName = keyof typeof toolSchemas;
export const ActionSchema = z
  .object({
    tool: z.enum(Object.keys(toolSchemas) as [ToolName, ...ToolName[]]),
    arguments: z.record(z.unknown()),
  })
  .strict()
  .superRefine((action, ctx) => {
    const parsed = toolSchemas[action.tool].safeParse(action.arguments);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: parsed.error.message });
  });
export type Action = z.infer<typeof ActionSchema>;
export const actionJsonSchema = {
  type: "object",
  required: ["tool", "arguments"],
  additionalProperties: false,
  properties: {
    tool: { type: "string", enum: Object.keys(toolSchemas) },
    arguments: { type: "object" },
  },
};
// One typed action per model turn. Tool arguments are validated before dispatch.
export const TOOL_HELP = `list_tree {path?,maxEntries?}; read_file {path,startLine?,endLine?}; ripgrep {pattern,path?,maxMatches?}; tree_sitter_symbols {path}; edit_file {path,patch} (single-file unified diff, include --- a/path and +++ b/path); run_shell {command,cwd?,timeoutMs?}; git {operation:status|diff|log|show,revision?}; update_plan {plan:[{id,content,status:pending|in_progress|done,notes?}]}; request_completion {summary}. No other argument keys. Paths relative to /workspace.`;
