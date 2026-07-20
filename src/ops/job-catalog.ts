import { z } from "zod";

export const JOB_CATALOG = [
  ["discover_github_candidates", "github", "github.candidates", "discover.yml"],
  ["collect_github_trending", "github", "github.trending", "trending.yml"],
  ["refresh_repo_metrics", "github", "github.metrics", "refresh-metrics.yml"],
  ["collect_x_posts", "local", "x.posts.collect", "collect-x.yml"],
  ["analyze_x_posts", "local", "x.posts.analyze", "collect-x.yml"],
  ["collect_x_comments", "local", "x.comments.collect", "collect-x.yml"],
  ["generate_report", "github", "reports.daily", "daily-report.yml"],
  ["evaluate_success", "github", "maintenance.evaluate", "evaluate-success.yml"],
  ["retention", "github", "maintenance.retention", "retention.yml"],
] as const;

export type JobName = typeof JOB_CATALOG[number][0];
export type Executor = "github" | "local";
export interface JobDefinition { name: JobName; executor: Executor; capability: string; workflow: string; enabled: boolean; pausedAt?: Date | null }
const uuid = z.string().uuid();
const schemas: Record<JobName, z.ZodObject<z.ZodRawShape>> = {
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
const trusted = z.object({ command_id:z.string().uuid().optional(), orchestrator_run_id:z.string().regex(/^\d{1,20}$/).optional(), orchestrator_run_attempt:z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(), orchestrator_workflow:z.string().max(128).optional(), scheduler:z.literal("launchd").optional(), scheduler_run_id:z.string().uuid().optional() }).partial();
export function jobDefinition(name: string): JobDefinition {
  const row = JOB_CATALOG.find((x) => x[0] === name);
  if (!row) throw new Error("unknown_job");
  return { name: row[0], executor: row[1], capability: row[2], workflow: row[3], enabled: true, pausedAt: null };
}
export function validateJobRequest(input: { name: string; executor?: Executor; capability?: string; parameters?: unknown }): { definition: JobDefinition; parameters: Record<string, unknown> } {
  const definition = jobDefinition(input.name);
  if (input.executor && input.executor !== definition.executor) throw new Error("executor_mismatch");
  if (input.capability && input.capability !== definition.capability) throw new Error("capability_mismatch");
  const parameters = params.parse(input.parameters ?? {}) as Record<string, unknown>;
  const schema = schemas[definition.name].extend(trusted.shape).strict();
  const parsed = schema.parse(parameters) as Record<string, unknown>;
  if (parsed.orchestrator_workflow !== undefined && parsed.orchestrator_workflow !== definition.workflow) {
    throw new Error("workflow_mismatch");
  }
  return { definition, parameters: parsed };
}
