import { cp, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type RepoConfig, RepoConfigSchema } from "../config";
import { RunError } from "../runtime/types";
import { processRun } from "./process";

export interface RepositoryCopy {
  repo: string;
  config: RepoConfig;
  files: number;
}
export async function copyRepository(
  repoPath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<RepositoryCopy> {
  const repo = await realpath(repoPath);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const list = await processRun(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      repo,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { signal, env, maxBytes: 10000000 },
  );
  if (list.exitCode !== 0 || list.omittedBytes)
    throw new RunError(
      "SANDBOX_ERROR",
      "Expected a local Git repository with a bounded file inventory",
    );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let total = 0,
    files = 0;
  for (const path of new Set(list.stdout.split("\0").filter(Boolean))) {
    signal?.throwIfAborted();
    const parts = path.split("/");
    if (
      parts.some(
        (x) =>
          [
            ".git",
            ".agent",
            ".aws",
            ".ssh",
            "node_modules",
            ".venv",
            "target",
            "dist",
            "coverage",
          ].includes(x) ||
          x === ".env" ||
          (x.startsWith(".env.") && x !== ".env.example"),
      )
    )
      continue;
    const source = resolve(repo, path),
      rel = relative(repo, source);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
      throw new RunError("SANDBOX_ERROR", "Unsafe Git inventory path");
    const canonical = await realpath(source);
    if (canonical !== source)
      throw new RunError("SANDBOX_ERROR", `Symlink sources are not supported: ${path}`);
    const s = await lstat(source);
    if (!s.isFile()) throw new RunError("SANDBOX_ERROR", `Unsupported source entry: ${path}`);
    total += s.size;
    if (s.size > 100000000 || total > 500000000)
      throw new RunError("SANDBOX_ERROR", "Source copy size limit exceeded");
    const target = join(destination, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(source, target, { dereference: false });
    files++;
  }
  let config: RepoConfig = RepoConfigSchema.parse({});
  try {
    config = RepoConfigSchema.parse(
      JSON.parse(await readFile(join(destination, ".minicoder.json"), "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new RunError("SANDBOX_ERROR", "Invalid .minicoder.json");
  }
  return { repo, config, files };
}
