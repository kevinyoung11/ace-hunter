import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import {
  adminEnvSchema,
  loadConfigShape,
  migrationEnvSchema,
  readonlyRuntimeEnvSchema,
  runtimeEnvSchema,
} from "./schema.js";

function mergedEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const fileEnv = env.ACE_HUNTER_ENV_FILE
    ? parseStrictDotenv(readFileSync(env.ACE_HUNTER_ENV_FILE, "utf8"))
    : {};
  const definedEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...fileEnv, ...definedEnv };
}

function parseStrictDotenv(source: string): Record<string, string> {
  const normalized = source.replace(/\r\n?/g, "\n");
  const assignment =
    /^\s*(?:export\s+)?[\w.-]+(?:\s*=\s*?|:\s+?)(?:\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|(?!\s*['"`])[^#\r\n]+)?\s*(?:#.*)?$/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(normalized)) !== null) {
    assertIgnorableDotenvGap(normalized.slice(cursor, match.index), normalized, cursor);
    cursor = assignment.lastIndex;
  }
  assertIgnorableDotenvGap(normalized.slice(cursor), normalized, cursor);
  return parse(normalized);
}

function assertIgnorableDotenvGap(gap: string, source: string, offset: number): void {
  if (gap.split("\n").every((line) => line.trim() === "" || line.trim().startsWith("#"))) {
    return;
  }
  const line = source.slice(0, offset).split("\n").length;
  throw new Error(`Invalid dotenv syntax at line ${line}`);
}

export function loadMigrationConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  const parsed = migrationEnvSchema.safeParse(mergedEnv(env));
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration keys: ${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    );
  }
  return {
    migrationDatabaseUrl: parsed.data.ACE_HUNTER_MIGRATION_DATABASE_URL,
    migrationSha256: parsed.data.ACE_HUNTER_MIGRATION_SHA256,
  };
}

export function loadAdminConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  const parsed = adminEnvSchema.safeParse(mergedEnv(env));
  if (!parsed.success) {
    throw new Error("Invalid configuration keys: ACE_HUNTER_ADMIN_DATABASE_URL");
  }
  return { adminDatabaseUrl: parsed.data.ACE_HUNTER_ADMIN_DATABASE_URL };
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  const parsed = runtimeEnvSchema.safeParse(mergedEnv(env));
  if (!parsed.success) {
    const keys = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration keys: ${keys}`);
  }
  return loadConfigShape(parsed.data);
}

export function loadReadonlyRuntimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  const parsed = readonlyRuntimeEnvSchema.safeParse(mergedEnv(env));
  if (!parsed.success) {
    throw new Error("Invalid configuration keys: ACE_HUNTER_RUNTIME_DATABASE_URL");
  }
  return { runtimeDatabaseUrl: parsed.data.ACE_HUNTER_RUNTIME_DATABASE_URL };
}

export function loadRedactionRegistry(env: NodeJS.ProcessEnv): string[] {
  let values: Record<string, string | undefined> = { ...env };
  try {
    values = mergedEnv(env);
  } catch {
    // Top-level error handling must still redact process-provided secrets.
  }
  return [
    values.ACE_HUNTER_ADMIN_DATABASE_URL,
    values.ACE_HUNTER_MIGRATION_DATABASE_URL,
    values.ACE_HUNTER_RUNTIME_DATABASE_URL,
    values.ACE_HUNTER_GITHUB_TOKEN,
    values.ACE_HUNTER_DEEPSEEK_API_KEY,
  ].filter((value): value is string => Boolean(value));
}
