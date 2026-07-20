import type { Command } from "commander";
import { z } from "zod";
import type { JobInput } from "../../jobs/job-runner.js";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";

const safeText = z.string().min(1).max(128).refine((value) =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }));
const hostedWorkflows = [
  "discover.yml",
  "trending.yml",
  "refresh-metrics.yml",
  "collect-x.yml",
  "daily-report.yml",
  "retention.yml",
  "evaluate-success.yml",
] as const;
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hostedSchema = z.object({
  orchestratorRunId: safeText.regex(/^\d{1,20}$/),
  orchestratorRunAttempt: safeText.regex(/^(?:[1-9]|[1-9]\d|100)$/),
  orchestratorWorkflow: z.enum(hostedWorkflows),
}).strict();
const localSchema = z.object({
  scheduler: z.literal("launchd"),
  schedulerRunId: safeText.regex(canonicalUuid),
}).strict();

interface JobOptions {
  commandId?: string;
  period?: string;
  scheduledFor?: string;
  cutoffHourUtc?: string;
  maxNew?: string;
  productId?: string;
  orchestratorRunId?: string;
  orchestratorRunAttempt?: string;
  orchestratorWorkflow?: string;
  scheduler?: string;
  schedulerRunId?: string;
}

export function registerJobCommand(program: Command, dependencies: CliDependencies): void {
  program
    .command("job <name>")
    .description("Execute a scheduled or manual collection job")
    .option("--period <period>")
    .option("--scheduled-for <iso>")
    .option("--cutoff-hour-utc <hour>")
    .option("--max-new <count>", "discovery insertion cap")
    .option("--product-id <uuid>", "run a product-batch job for one product")
    .option("--orchestrator-run-id <id>")
    .option("--orchestrator-run-attempt <attempt>")
    .option("--orchestrator-workflow <name>")
    .option("--scheduler <name>")
    .option("--scheduler-run-id <id>")
    .option("--command-id <uuid>", "durable command queue id")
    .action(async (name: string, options: JobOptions) => {
      await executeCommand(dependencies.io, async () => {
        let input: JobInput;
        try {
          const scheduledFor = parseScheduledFor(options.scheduledFor, dependencies.now?.() ?? new Date());
          const jobName = parseJobName(name);
          if (options.productId !== undefined && !new Set(["collect_x_posts", "analyze_x_posts", "collect_x_comments"]).has(jobName)) {
            throw new Error("product scope unsupported");
          }
          const attribution = parseAttribution(options);
          if (attribution.scheduler === "launchd" && !new Set([
            "collect_x_posts",
            "analyze_x_posts",
            "collect_x_comments",
          ]).has(jobName)) {
            throw new Error("launchd is reserved for the X pipeline");
          }
          const parameters = {
            ...parseCoreParameters(options),
            ...attribution,
            ...(options.commandId !== undefined ? { command_id: canonicalUuidValue(options.commandId) } : {}),
          };
          input = {
            name: jobName,
            triggerType: Object.keys(attribution).length > 0 ? "schedule" : "manual",
            scheduledFor,
            parameters,
            commandId: options.commandId?.toLowerCase(),
          };
        } catch {
          throw Object.assign(new Error("invalid job attribution"), { code: "invalid_job_attribution" });
        }
        return dependencies.runJob(input);
      });
    });
}

function parseAttribution(options: JobOptions): Record<string, string> {
  const hostedValues = [options.orchestratorRunId, options.orchestratorRunAttempt, options.orchestratorWorkflow];
  const localValues = [options.scheduler, options.schedulerRunId];
  const hasHosted = hostedValues.some((value) => value !== undefined);
  const hasLocal = localValues.some((value) => value !== undefined);
  if (!hasHosted && !hasLocal) return {};
  if (hasHosted && hasLocal) throw new Error("mixed attribution");
  if (hasHosted) {
    const value = hostedSchema.parse({
      orchestratorRunId: options.orchestratorRunId,
      orchestratorRunAttempt: options.orchestratorRunAttempt,
      orchestratorWorkflow: options.orchestratorWorkflow,
    });
    return {
      orchestrator_run_id: value.orchestratorRunId,
      orchestrator_run_attempt: value.orchestratorRunAttempt,
      orchestrator_workflow: value.orchestratorWorkflow,
    };
  }
  const value = localSchema.parse({
    scheduler: options.scheduler,
    schedulerRunId: options.schedulerRunId,
  });
  return { scheduler: value.scheduler, scheduler_run_id: value.schedulerRunId };
}

function parseCoreParameters(options: JobOptions): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (options.period !== undefined) {
    if (!["daily", "weekly", "monthly"].includes(options.period)) throw new Error("period");
    result.period = options.period;
  }
  if (options.cutoffHourUtc !== undefined) {
    result.cutoff_hour_utc = boundedInteger(options.cutoffHourUtc, 0, 23);
  }
  if (options.maxNew !== undefined) result.max_new = boundedInteger(options.maxNew, 1, 1_000);
  if (options.productId !== undefined) {
    if (!canonicalUuid.test(options.productId)) throw new Error("productId");
    result.productId = options.productId.toLowerCase();
  }
  return result;
}

function parseScheduledFor(value: string | undefined, fallback: Date): Date {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (value !== undefined && !match) {
    throw new Error("scheduledFor");
  }
  const parsed = value === undefined ? new Date(fallback) : new Date(value);
  const normalizedInput = match ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z` : null;
  if (!Number.isFinite(parsed.getTime()) || (normalizedInput !== null && parsed.toISOString() !== normalizedInput)) {
    throw new Error("scheduledFor");
  }
  return parsed;
}

function parseJobName(value: string): string {
  return safeText.regex(/^[a-z0-9][a-z0-9_.:-]{0,127}$/).parse(value);
}

function canonicalUuidValue(value: string): string {
  if (!canonicalUuid.test(value)) throw new Error("commandId");
  return value.toLowerCase();
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error("integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error("integer");
  return parsed;
}
