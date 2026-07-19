import type { Pool } from "pg";
import type { ContentAnalyzer } from "../analysis/content-analyzer.js";
import { analyzeXPosts } from "../jobs/analyze-x-posts.js";
import { collectGithubTrending } from "../jobs/collect-github-trending.js";
import { collectXComments } from "../jobs/collect-x-comments.js";
import { collectXPosts } from "../jobs/collect-x-posts.js";
import { discoverGithubCandidates } from "../jobs/discover-github-candidates.js";
import { generateReport } from "../jobs/generate-report.js";
import {
  JobError,
  JobRunner,
  type JobContext,
  type JobInput,
  type JobResult,
} from "../jobs/job-runner.js";
import { refreshRepoMetrics } from "../jobs/refresh-repo-metrics.js";
import { compactSnapshots } from "../jobs/retention.js";
import type {
  GitHubMetricSourceFactory,
  GitHubSourceFactory,
} from "../sources/github/github-source.js";
import type { TrendingSource } from "../sources/trending/trending-source.js";
import type { XSourceAdapter } from "../sources/x/x-source.js";
import type { CommandOutput } from "./output.js";

export interface JobDispatcherDependencies {
  pool: Pool;
  lockPool: Pool;
  loadedSecrets: readonly string[];
  githubSourceFactory: GitHubSourceFactory & GitHubMetricSourceFactory;
  trendingSource: TrendingSource;
  xSource: XSourceAdapter;
  analyzer: ContentAnalyzer | null;
  cleanupX?: () => Promise<void>;
}

export type JobDispatcher = (input: JobInput) => Promise<CommandOutput & {
  runId: string;
  status: string;
  executed: boolean;
}>;

export function createJobDispatcher(
  dependencies: JobDispatcherDependencies,
): JobDispatcher {
  const runner = new JobRunner(dependencies.pool, {
    lockPool: dependencies.lockPool,
    loadedSecrets: dependencies.loadedSecrets,
  });
  return async (input) => {
    let outcome;
    try {
      outcome = await runner.run(input, async (context) =>
        dispatch(dependencies, runner, input, context));
    } catch (error) {
      if (error instanceof Error && /^job failed \([a-z_]+\)$/u.test(error.message)) {
        throw Object.assign(new Error("job failed"), { code: "job_failed" });
      }
      throw error;
    }
    if (outcome.status === "failed") {
      throw Object.assign(new Error("job failed"), { code: "job_failed", runId: outcome.runId });
    }
    return { kind: "job_run", ...outcome };
  };
}

async function dispatch(
  dependencies: JobDispatcherDependencies,
  runner: JobRunner,
  input: JobInput,
  context: JobContext,
): Promise<JobResult> {
  switch (input.name) {
    case "discover_github_candidates":
      return discoverGithubCandidates({
        pool: dependencies.pool,
        sourceFactory: dependencies.githubSourceFactory,
        emitOperationalEvent: () => undefined,
      }, context.scheduledFor, {
        runId: context.runId,
        maxNew: optionalInteger(input.parameters.max_new),
      });
    case "collect_github_trending":
      return collectGithubTrending({
        pool: dependencies.pool,
        sourceFactory: dependencies.githubSourceFactory,
        trendingSource: dependencies.trendingSource,
      }, {
        period: trendingPeriod(input.parameters.period),
        scheduledFor: context.scheduledFor,
        runId: context.runId,
      });
    case "refresh_repo_metrics":
      return refreshRepoMetrics({
        pool: dependencies.pool,
        sourceFactory: dependencies.githubSourceFactory,
      }, {
        scheduledFor: context.scheduledFor,
        granularity: "hourly",
        runId: context.runId,
      });
    case "collect_x_posts":
      return withXCleanup(dependencies, () => runProductBatch(dependencies.pool, runner, input, context, "collect_x_posts",
        (productId) => collectXPosts({ pool: dependencies.pool, source: dependencies.xSource }, {
          productId, observedAt: context.scheduledFor,
        })));
    case "analyze_x_posts":
      return withXCleanup(dependencies, () => runProductBatch(dependencies.pool, runner, input, context, "analyze_x_posts",
        (productId) => analyzeXPosts({ pool: dependencies.pool, analyzer: requireAnalyzer(dependencies.analyzer) }, {
          productId, observedAt: context.scheduledFor,
        })));
    case "collect_x_comments":
      return withXCleanup(dependencies, () => runProductBatch(dependencies.pool, runner, input, context, "collect_x_comments",
        (productId) => collectXComments({
          pool: dependencies.pool,
          source: dependencies.xSource,
          analyzer: requireAnalyzer(dependencies.analyzer),
        }, { productId, observedAt: context.scheduledFor })));
    case "generate_report": {
      const cutoff = reportCutoff(context.scheduledFor, input.parameters.cutoff_hour_utc);
      const generated = await generateReport({ pool: dependencies.pool }, cutoff);
      return { expected: generated.report.items.length, succeeded: generated.report.items.length, failed: [], skipped: 0 };
    }
    case "retention": {
      const result = await compactSnapshots(dependencies.pool, context.scheduledFor);
      const count = result.snapshotsDeleted + result.jobRunsDeleted;
      return { expected: count, succeeded: count, failed: [], skipped: 0 };
    }
    default:
      throw new JobError("validation_error", false, "unsupported job name");
  }
}

async function withXCleanup<T>(dependencies: JobDispatcherDependencies, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await dependencies.cleanupX?.();
  }
}

async function runProductBatch(
  pool: Pool,
  runner: JobRunner,
  parentInput: JobInput,
  parentContext: JobContext,
  name: string,
  handler: (productId: string) => Promise<JobResult>,
): Promise<JobResult> {
  if (typeof parentInput.parameters.productId === "string") {
    return handler(parentInput.parameters.productId);
  }
  const productIds = (await pool.query<{ id: string }>(
    "select id from ace_hunter.products where status='active' order by id",
  )).rows.map((row) => row.id);
  const failed: Array<{ id: string; code: string }> = [];
  let succeeded = 0;
  for (const productId of productIds) {
    const child = await runner.run({
      name,
      triggerType: parentInput.triggerType,
      scheduledFor: parentContext.scheduledFor,
      parameters: { ...parentInput.parameters, productId },
      parentRunId: parentContext.runId,
      dataCutoffAt: parentInput.dataCutoffAt,
    }, () => handler(productId));
    if (child.status === "success") succeeded += 1;
    else failed.push({ id: productId, code: "item_failed" });
  }
  return { expected: productIds.length, succeeded, failed, skipped: 0 };
}

function trendingPeriod(value: unknown): "daily" | "weekly" | "monthly" {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  throw new JobError("validation_error", false, "trending period is required");
}

function reportCutoff(scheduledFor: Date, rawHour: unknown): Date {
  const hour = rawHour === undefined ? 0 : rawHour;
  if (!Number.isInteger(hour) || Number(hour) < 0 || Number(hour) > 23) {
    throw new JobError("validation_error", false, "invalid report cutoff hour");
  }
  const cutoff = new Date(Date.UTC(
    scheduledFor.getUTCFullYear(),
    scheduledFor.getUTCMonth(),
    scheduledFor.getUTCDate(),
    Number(hour),
  ));
  if (cutoff > scheduledFor || Number(hour) !== 0) {
    throw new JobError("validation_error", false, "daily report cutoff must be 08:00 Asia/Shanghai");
  }
  return cutoff;
}

function requireAnalyzer(analyzer: ContentAnalyzer | null): ContentAnalyzer {
  if (!analyzer) throw new JobError("authentication_error", false, "content analyzer is not configured");
  return analyzer;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new JobError("validation_error", false, "invalid integer parameter");
  return Number(value);
}
