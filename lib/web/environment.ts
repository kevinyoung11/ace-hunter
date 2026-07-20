import { z } from "zod";

const schema = z.object({
  ACE_HUNTER_RUNTIME_DATABASE_URL: z.string().url(),
  ACE_HUNTER_USER_ID: z.string().uuid(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

export interface WebConfig {
  readonly runtimeDatabaseUrl: string;
  readonly ownerUserId: string;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
}

export function loadWebConfig(env: Record<string, string | undefined>): WebConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid web configuration keys: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  return Object.freeze({
    runtimeDatabaseUrl: parsed.data.ACE_HUNTER_RUNTIME_DATABASE_URL,
    ownerUserId: parsed.data.ACE_HUNTER_USER_ID,
    supabaseUrl: parsed.data.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: parsed.data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

/**
 * Read each key explicitly so Next can include the required values in the
 * server and proxy bundles. Passing the entire process.env object prevents
 * Edge/Proxy builds from retaining non-public environment variables.
 */
export function readWebConfig(): WebConfig {
  return loadWebConfig({
    ACE_HUNTER_RUNTIME_DATABASE_URL: process.env.ACE_HUNTER_RUNTIME_DATABASE_URL,
    ACE_HUNTER_USER_ID: process.env.ACE_HUNTER_USER_ID,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
