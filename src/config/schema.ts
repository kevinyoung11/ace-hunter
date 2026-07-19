import { z } from "zod";

export const adminEnvSchema = z.object({
  ACE_HUNTER_ADMIN_DATABASE_URL: z.string().url(),
});

export const migrationEnvSchema = z.object({
  ACE_HUNTER_MIGRATION_DATABASE_URL: z.string().url(),
  ACE_HUNTER_MIGRATION_SHA256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const runtimeEnvSchema = z.object({
  ACE_HUNTER_RUNTIME_DATABASE_URL: z.string().url(),
  ACE_HUNTER_GITHUB_TOKEN: z.string().min(1),
  ACE_HUNTER_USER_ID: z.string().uuid(),
  TWITTER_CLI_PATH: z.string().min(1).default("twitter"),
  ACE_HUNTER_DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-chat"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = ReturnType<typeof loadConfigShape>;

export function loadConfigShape(env: z.infer<typeof runtimeEnvSchema>) {
  return {
    runtimeDatabaseUrl: env.ACE_HUNTER_RUNTIME_DATABASE_URL,
    githubToken: env.ACE_HUNTER_GITHUB_TOKEN,
    userId: env.ACE_HUNTER_USER_ID,
    twitterCliPath: env.TWITTER_CLI_PATH,
    deepseekApiKey: env.ACE_HUNTER_DEEPSEEK_API_KEY,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
    deepseekModel: env.DEEPSEEK_MODEL,
    logLevel: env.LOG_LEVEL,
  };
}

export function loadedSecretValues(config: AppConfig): string[] {
  return [config.runtimeDatabaseUrl, config.githubToken, config.deepseekApiKey].filter(
    (value): value is string => Boolean(value),
  );
}
