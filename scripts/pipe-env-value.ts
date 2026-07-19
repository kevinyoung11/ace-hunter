import { readFile } from "node:fs/promises";
import { parse } from "dotenv";

const allowed = new Set([
  "ACE_HUNTER_RUNTIME_DATABASE_URL",
  "ACE_HUNTER_GITHUB_TOKEN",
  "ACE_HUNTER_USER_ID",
  "ACE_HUNTER_DEEPSEEK_API_KEY",
]);
const args = process.argv.slice(2);
if (args.length === 1) {
  const key = requireAllowed(args[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8");
  if (value.length === 0 || value.length > 16_384 || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 10 || code === 13;
  })) throw new Error("invalid_env_value");
  process.stdout.write(`${key}=${JSON.stringify(value)}\n`);
} else if (args.length === 2) {
  const [path, rawKey] = args;
  const key = requireAllowed(rawKey);
  if (!path.startsWith("/")) throw new Error("absolute_env_path_required");
  const values = parse(await readFile(path, "utf8"));
  const value = values[key];
  if (!value) throw new Error("env_value_missing");
  process.stdout.write(value);
} else {
  throw new Error("usage_error");
}

function requireAllowed(key: string): string {
  if (!allowed.has(key)) throw new Error("env_key_not_allowed");
  return key;
}
