import { constants } from "node:fs";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSourceDotenv, serializeDotenv } from "./prepare-live-env.js";

const runtimeKeys = [
  "ACE_HUNTER_RUNTIME_DATABASE_URL", "ACE_HUNTER_GITHUB_TOKEN", "ACE_HUNTER_USER_ID",
  "ACE_HUNTER_DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "TWITTER_CLI_PATH", "LOG_LEVEL",
] as const;

export function runtimeEnvironment(source: Record<string, string>): Record<string, string> {
  const values = Object.fromEntries(runtimeKeys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])) as Record<string, string>;
  for (const key of ["ACE_HUNTER_RUNTIME_DATABASE_URL", "ACE_HUNTER_GITHUB_TOKEN", "ACE_HUNTER_USER_ID"]) {
    if (!values[key]) throw new Error("runtime_environment_incomplete");
  }
  return values;
}

async function main(): Promise<void> {
  const [sourcePath, destination] = process.argv.slice(2);
  if (!sourcePath || !destination || !isAbsolute(sourcePath) || !isAbsolute(destination)) throw new Error("usage_error");
  await access(sourcePath, constants.R_OK);
  await writeFile(destination, serializeDotenv(runtimeEnvironment(parseSourceDotenv(await readFile(sourcePath, "utf8")))), { mode: 0o600, flag: "wx" });
  await chmod(destination, 0o600);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
