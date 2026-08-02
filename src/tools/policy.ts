import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RunError } from "../runtime/types";

export function normalizePath(root: string, path: string): string {
  if (!path || path.includes("\0") || path.includes("\\"))
    throw new RunError("TOOL_ERROR", "Invalid workspace path");
  if (path.split("/").includes("..")) throw new RunError("TOOL_ERROR", "Path traversal rejected");
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new RunError("TOOL_ERROR", "Path outside workspace");
  if (
    rel
      .split(sep)
      .some((x) => [".git", ".agent", ".env", ".aws", ".ssh"].includes(x) || x.startsWith(".env."))
  )
    throw new RunError("TOOL_ERROR", "Protected workspace path");
  return absolute;
}
export async function workspacePath(
  root: string,
  path: string,
  allowMissing = false,
): Promise<string> {
  const absolute = normalizePath(root, path);
  const base = await realpath(root);
  let cursor = base;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new RunError("TOOL_ERROR", "Symlink paths are rejected");
    } catch (e) {
      if (allowMissing && (e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
  }
  return cursor;
}
export function shellPolicy(command: string): void {
  // Defense in depth, not a shell security boundary. Docker supplies the actual isolation.
  if (
    /(?:\bsudo\b|\bdocker\b|\bmount\b|\bnsenter\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\s+.*of=\/dev|\bgit\s+(?:push|fetch|pull|clone)|\brm\s+(?:-[^\s]+\s+)*\/(?:\s|\*|$)|\/var\/run\/docker\.sock)/i.test(
      command,
    )
  )
    throw new RunError("TOOL_ERROR", "Command blocked by runtime policy");
}
