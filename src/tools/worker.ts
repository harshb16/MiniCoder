import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import Parser from "web-tree-sitter";
import { type ToolName, toolSchemas } from "../models/schema";
import { RunError } from "../runtime/types";
import { processRun } from "../sandbox/process";
import { shellPolicy, workspacePath } from "./policy";

const ROOT = "/workspace";
const ignores = [
  ".git",
  "node_modules",
  ".agent",
  "dist",
  "build",
  "coverage",
  ".venv",
  "target",
  "vendor",
  "__pycache__",
];
const rgArgs = [
  "--hidden",
  "--glob",
  "!.env",
  "--glob",
  "!.env.*",
  ...ignores.flatMap((x) => ["--glob", `!${x}/**`]),
];
async function fileText(path: string): Promise<string> {
  if ((await stat(path)).size > 2000000)
    throw new RunError("TOOL_ERROR", "File exceeds 2 MB read limit; use ripgrep");
  const text = await readFile(path, "utf8");
  if (text.includes("\0")) throw new RunError("TOOL_ERROR", "Binary file rejected");
  return text;
}
export async function patchFile(path: string, patch: string): Promise<unknown> {
  const full = await workspacePath(ROOT, path, true);
  const rel = relative(ROOT, full);
  if (!rel) throw new RunError("TOOL_ERROR", "Cannot edit workspace root");
  // The diff's terminator is distinct from the target file's newline markers.
  if (!patch.endsWith("\n")) patch += "\n";
  const lines = patch.split("\n");
  const oldHeaders = lines.filter((x) => x.startsWith("--- "));
  const newHeaders = lines.filter((x) => x.startsWith("+++ "));
  if (
    oldHeaders.length !== 1 ||
    newHeaders.length !== 1 ||
    /^(?:GIT binary patch|rename |copy |old mode|new mode)/m.test(patch)
  )
    throw new RunError("TOOL_ERROR", "Expected one text-file unified patch");
  if (
    ![`--- a/${rel}`, "--- /dev/null"].includes(oldHeaders[0] ?? "") ||
    ![`+++ b/${rel}`, "+++ /dev/null"].includes(newHeaders[0] ?? "")
  )
    throw new RunError("TOOL_ERROR", "Patch header does not match canonical path");
  if (lines.some((x) => x.startsWith("diff --git ") && x !== `diff --git a/${rel} b/${rel}`))
    throw new RunError("TOOL_ERROR", "Invalid diff path");
  await mkdir(dirname(full), { recursive: true });
  const check = await processRun(
    "git",
    ["-c", "core.hooksPath=/dev/null", "apply", "--check", "--whitespace=nowarn", "-"],
    { cwd: ROOT, input: patch },
  );
  if (check.exitCode !== 0)
    throw new RunError("TOOL_ERROR", `Patch validation failed: ${check.stderr}`);
  const result = await processRun(
    "git",
    ["-c", "core.hooksPath=/dev/null", "apply", "--whitespace=nowarn", "-"],
    { cwd: ROOT, input: patch },
  );
  if (result.exitCode !== 0) throw new RunError("TOOL_ERROR", `Patch failed: ${result.stderr}`);
  return {
    path: rel,
    added: lines.filter((x) => x.startsWith("+") && !x.startsWith("+++")).length,
    removed: lines.filter((x) => x.startsWith("-") && !x.startsWith("---")).length,
  };
}
async function symbols(path: string): Promise<unknown> {
  const full = await workspacePath(ROOT, path);
  const text = await fileText(full);
  const languages: Record<string, string> = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
  };
  const lang = languages[extname(full)];
  if (!lang) throw new RunError("TOOL_ERROR", "Supported: JS, TS, TSX, Python, Go, Rust");
  await Parser.init();
  const parser = new Parser();
  const language = await Parser.Language.load(
    join(import.meta.dir, "../../node_modules/tree-sitter-wasms/out", `tree-sitter-${lang}.wasm`),
  );
  parser.setLanguage(language);
  const tree = parser.parse(text);
  const results: unknown[] = [];
  let visited = 0;
  const kinds = new Set([
    "function_declaration",
    "function_definition",
    "method_definition",
    "class_declaration",
    "class_definition",
    "interface_declaration",
    "type_alias_declaration",
    "struct_item",
    "enum_item",
    "function_item",
    "method_declaration",
    "type_spec",
    "lexical_declaration",
  ]);
  function walk(node: Parser.SyntaxNode): void {
    if (++visited > 100000 || results.length >= 250) return;
    if (kinds.has(node.type)) {
      const name =
        node.childForFieldName("name") ??
        node.namedChildren.find((x) => x.type === "variable_declarator")?.childForFieldName("name");
      if (name)
        results.push({
          name: name.text,
          kind: node.type,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
    }
    for (const child of node.namedChildren) walk(child);
  }
  try {
    walk(tree.rootNode);
    return {
      language: lang,
      symbols: results,
      parseErrors: tree.rootNode.hasError(),
      bounded: results.length >= 250 || visited > 100000,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}
export async function auditWorkspace(): Promise<unknown> {
  const violations: string[] = [];
  let count = 0;
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++count > 100000) throw new RunError("TOOL_ERROR", "Workspace audit exceeds file limit");
      const full = join(dir, item.name),
        rel = relative(ROOT, full);
      if (
        item.name === ".git" ||
        item.name === ".agent" ||
        item.name === ".ssh" ||
        item.name === ".aws" ||
        item.name === ".env" ||
        (item.name.startsWith(".env.") && item.name !== ".env.example")
      ) {
        violations.push(rel);
        continue;
      }
      if (ignores.includes(item.name)) continue;
      const s = await lstat(full);
      if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) violations.push(rel);
      else if (s.isDirectory()) await walk(full);
    }
  }
  await walk(ROOT);
  return { violations };
}
export async function worker(tool: ToolName | "audit", args: unknown): Promise<unknown> {
  if (tool === "audit") return auditWorkspace();
  switch (tool) {
    case "list_tree": {
      const a = toolSchemas.list_tree.parse(args);
      const path = await workspacePath(ROOT, a.path);
      const r = await processRun("rg", ["--files", ...rgArgs, path], { maxBytes: 2000000 });
      if (r.exitCode > 1) throw new RunError("TOOL_ERROR", r.stderr);
      const files = r.stdout.trim().split("\n").filter(Boolean);
      return {
        files: files.slice(0, a.maxEntries).map((x) => relative(ROOT, x)),
        omitted: Math.max(0, files.length - a.maxEntries),
      };
    }
    case "read_file": {
      const a = toolSchemas.read_file.parse(args);
      if (a.endLine < a.startLine || a.endLine - a.startLine > 1000)
        throw new RunError("TOOL_ERROR", "Read at most 1000 lines");
      const text = await fileText(await workspacePath(ROOT, a.path));
      const lines = text.split("\n");
      return {
        path: a.path,
        totalLines: lines.length,
        content: lines
          .slice(a.startLine - 1, a.endLine)
          .map((x, i) => `${a.startLine + i}: ${x}`)
          .join("\n"),
      };
    }
    case "ripgrep": {
      const a = toolSchemas.ripgrep.parse(args);
      const path = await workspacePath(ROOT, a.path);
      const r = await processRun(
        "rg",
        [
          "--no-config",
          "--line-number",
          "--color",
          "never",
          "--max-count",
          String(a.maxMatches),
          ...rgArgs,
          "--",
          a.pattern,
          path,
        ],
        { maxBytes: 1000000, timeoutMs: 10000 },
      );
      if (r.timedOut) throw new RunError("COMMAND_TIMEOUT", "Search timed out");
      if (r.exitCode > 1) throw new RunError("TOOL_ERROR", r.stderr);
      const lines = r.stdout.split("\n").filter(Boolean);
      return {
        matches: lines.slice(0, a.maxMatches),
        omitted: Math.max(0, lines.length - a.maxMatches),
        omittedBytes: r.omittedBytes,
      };
    }
    case "tree_sitter_symbols":
      return symbols(toolSchemas.tree_sitter_symbols.parse(args).path);
    case "edit_file": {
      const a = toolSchemas.edit_file.parse(args);
      return patchFile(a.path, a.patch);
    }
    case "run_shell": {
      const a = toolSchemas.run_shell.parse(args);
      shellPolicy(a.command);
      const cwd = await workspacePath(ROOT, a.cwd);
      const r = await processRun("/bin/bash", ["-c", a.command], {
        cwd,
        timeoutMs: a.timeoutMs ?? 60000,
        maxBytes: 1000000,
      });
      return r;
    }
    default:
      throw new RunError("TOOL_ERROR", "Tool is controlled by runtime");
  }
}
if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const value = await worker(input.tool, input.arguments);
    console.log(JSON.stringify({ ok: true, value }));
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false,
        code: e instanceof RunError ? e.code : "TOOL_ERROR",
        message: e instanceof Error ? e.message : "Tool failed",
      }),
    );
  }
}
