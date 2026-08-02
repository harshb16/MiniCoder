import { processRun } from "../src/sandbox/process";

const tracked = await processRun("git", ["ls-files", "-z"]);
const names = tracked.stdout.split("\0").filter(Boolean);
if (
  names.some(
    (name) => name === ".env" || (/(^|\/)\.env\./.test(name) && !name.endsWith(".env.example")),
  )
)
  throw new Error("Secret environment file is tracked");
const history = await processRun("git", ["log", "--all", "-p", "--format="], {
  maxBytes: 20000000,
});
const staged = await processRun("git", ["diff", "--cached"], { maxBytes: 20000000 });
if (history.omittedBytes || staged.omittedBytes)
  throw new Error("Secret audit requires untruncated Git data");
const content = history.stdout + staged.stdout;
const keys = [process.env.GEMINI_API_KEY, process.env.FREELLMAPI_API_KEY].filter(
  (key): key is string => Boolean(key),
);
if (
  keys.some((key) => content.includes(key)) ||
  /AIza[\w-]{30,}|\bsk-[A-Za-z0-9_-]{30,}/.test(content)
)
  throw new Error("Potential credential detected in Git data");
console.log("Secret audit passed: no tracked .env or detected credentials in history/staged diff.");
