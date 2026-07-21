import { z } from "zod";

const schema = z.object({
  ACE_HUNTER_OPS_DATABASE_URL: z.string().url(),
  ACE_HUNTER_OPS_ORIGIN: z.string().url(),
  ACE_HUNTER_OPS_API_TOKEN: z.string().min(16),
  GITHUB_TOKEN: z.string().min(1).optional(),
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
  ACE_HUNTER_OPS_TICK_SECRET: z.string().min(16).optional(),
});
export type OpsConfig = z.infer<typeof schema>;
export function loadOpsConfig(env: Record<string, string | undefined> = process.env): OpsConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid ops configuration keys: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}
