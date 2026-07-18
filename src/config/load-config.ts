import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import {
  adminEnvSchema,
  loadConfigShape,
  migrationEnvSchema,
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
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const assignment = trimmed.match(
      /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/,
    );
    if (!assignment) throw new Error(`Invalid dotenv syntax at line ${index + 1}`);

    const value = assignment[1];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) !== quote) {
      throw new Error(`Invalid dotenv syntax at line ${index + 1}`);
    }
  }
  return parse(source);
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
