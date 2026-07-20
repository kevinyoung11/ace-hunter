import { z } from "zod";

export const JOB_CATALOG = [
  ["discover_github_candidates", "github", "github.candidates"],
  ["collect_github_trending", "github", "github.trending"],
  ["refresh_repo_metrics", "github", "github.metrics"],
  ["collect_x_posts", "local", "x.posts.collect"],
  ["analyze_x_posts", "local", "x.posts.analyze"],
  ["collect_x_comments", "local", "x.comments.collect"],
  ["generate_report", "github", "reports.daily"],
  ["evaluate_success", "github", "maintenance.evaluate"],
  ["retention", "github", "maintenance.retention"],
] as const;

export type JobName = typeof JOB_CATALOG[number][0];
export type Executor = "github" | "local";
export interface JobDefinition { name: JobName; executor: Executor; capability: string; enabled: boolean; pausedAt?: Date | null }
const uuid = z.string().uuid();
const schemas: Record<JobName, z.ZodTypeAny> = {
  discover_github_candidates: z.object({ max_new: z.number().int().min(1).max(1000).optional() }).strict(),
  collect_github_trending: z.object({ period: z.enum(["daily","weekly","monthly"]).optional() }).strict(),
  refresh_repo_metrics: z.object({}).strict(),
  collect_x_posts: z.object({ productId: uuid.optional(), product_id: uuid.optional() }).strict(),
  analyze_x_posts: z.object({ productId: uuid.optional(), product_id: uuid.optional() }).strict(),
  collect_x_comments: z.object({ productId: uuid.optional(), product_id: uuid.optional() }).strict(),
  generate_report: z.object({ cutoff_hour_utc: z.number().int().min(0).max(23).optional() }).strict(),
  evaluate_success: z.object({}).strict(),
  retention: z.object({}).strict(),
};

const params = z.record(z.string(), z.unknown()).default({});
export function jobDefinition(name: string): JobDefinition {
  const row = JOB_CATALOG.find((x) => x[0] === name);
  if (!row) throw new Error("unknown_job");
  return { name: row[0], executor: row[1], capability: row[2], enabled: true, pausedAt: null };
}
export function validateJobRequest(input: { name: string; executor?: Executor; capability?: string; parameters?: unknown }): { definition: JobDefinition; parameters: Record<string, unknown> } {
  const definition = jobDefinition(input.name);
  if (input.executor && input.executor !== definition.executor) throw new Error("executor_mismatch");
  if (input.capability && input.capability !== definition.capability) throw new Error("capability_mismatch");
  const parameters = params.parse(input.parameters ?? {}) as Record<string, unknown>;
  return { definition, parameters: schemas[definition.name].parse(parameters) as Record<string, unknown> };
}
