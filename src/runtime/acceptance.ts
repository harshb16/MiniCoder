import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";

const caseSchema = z
  .object({
    argv: z
      .tuple([z.string().max(4000).startsWith("/")])
      .rest(z.string().max(4000))
      .refine((argv) => argv.length <= 32 && argv.every((arg) => !arg.includes("\0"))),
    stdin: z.string().max(64000).optional(),
    stdout: z.string().max(64000),
  })
  .strict();
const acceptanceSchema = z.object({ cases: z.array(caseSchema).min(1).max(20) }).strict();
export type AcceptanceCase = z.infer<typeof caseSchema>;

export async function loadAcceptance(file: string, repo: string): Promise<AcceptanceCase[]> {
  const path = await realpath(file);
  const rel = relative(repo, path);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
    throw new Error("Trusted acceptance configuration must be outside the source repository");
  try {
    return acceptanceSchema.parse(JSON.parse(await readFile(path, "utf8"))).cases;
  } catch {
    throw new Error("Invalid trusted acceptance configuration");
  }
}
