import type { Pool } from "pg";
import { utcHourBucket } from "../core/time-buckets.js";
import { SnapshotStore } from "../db/stores/snapshot-store.js";
import { TrendingStore, type TrendingInsert } from "../db/stores/trending-store.js";
import { createProductFromRepo, type CapacityReviewOptions } from "../products/create-product-from-repo.js";
import type { GitHubSource, GitHubSourceFactory, GitHubSourceOperation } from "../sources/github/github-source.js";
import { GitHubSourceError } from "../sources/github/github-source.js";
import { canonicalTrendingUrl } from "../sources/trending/github-trending-source.js";
import type { TrendingCollection, TrendingEntry, TrendingPeriod, TrendingSource } from "../sources/trending/trending-source.js";
import { TrendingSourceError } from "../sources/trending/trending-source.js";
import { JobError, type JobResult } from "./job-runner.js";

export interface CollectGithubTrendingDependencies {
  pool: Pool;
  sourceFactory: GitHubSourceFactory;
  trendingSource: TrendingSource;
}

export interface CollectGithubTrendingOptions extends CapacityReviewOptions {
  period: TrendingPeriod;
  language?: string;
  scheduledFor: Date;
  runId?: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function collectGithubTrending(
  dependencies: CollectGithubTrendingDependencies,
  options: CollectGithubTrendingOptions,
): Promise<JobResult> {
  const language = options.language ?? "all";
  let expectedUrl: string;
  let capturedAt: Date;
  try {
    expectedUrl = canonicalTrendingUrl(options.period, language);
    capturedAt = utcHourBucket(options.scheduledFor);
  } catch {
    throw new JobError("validation_error", false, "invalid trending job input");
  }
  if (options.runId !== undefined && !uuid.test(options.runId)) {
    throw new JobError("validation_error", false, "invalid trending job input");
  }
  if (options.reviewedCapacityOverride === true && (!validReviewId(options.capacityReviewId) || !options.runId)) {
    throw new JobError("validation_error", false, "capacity review audit required");
  }

  let collection: TrendingCollection;
  try { collection = await dependencies.trendingSource.collect(options.period, language); }
  catch (error) { throw trendingJobError(error); }
  validateCollection(collection, expectedUrl);

  let source: GitHubSourceOperation;
  try { source = await dependencies.sourceFactory.openOperation(); }
  catch (error) { throw githubJobError(error); }
  let prepared: PreparedBatch | undefined;
  let primaryError: unknown;
  try { prepared = await enrichBatch(dependencies.pool, source, collection.entries, capturedAt, options); }
  catch (error) { primaryError = error; }
  try { await source.close(); }
  catch {
    if (primaryError === undefined) throw new JobError("source_unavailable", true, "github operation close failed");
  }
  if (primaryError !== undefined) throw primaryError;

  if (prepared!.rows.length === 0) {
    return { expected: collection.entries.length, succeeded: 0, failed: prepared!.failed, skipped: 0 };
  }

  const collectionStatus = prepared!.failed.length > 0 ? "partial" as const : "success" as const;
  const inserts: TrendingInsert[] = prepared!.rows.map(({ entry, repositoryId }) => ({
    repositoryId,
    period: options.period,
    language,
    capturedAt,
    rank: entry.rank,
    starsInPeriod: entry.starsInPeriod,
    sourceUrl: expectedUrl,
    collectionStatus,
    jobRunId: options.runId ?? null,
  }));
  try {
    await new TrendingStore(dependencies.pool).replaceBatch(inserts);
  } catch {
    throw new JobError("source_unavailable", true, "trending persistence unavailable");
  }
  return {
    expected: collection.entries.length,
    succeeded: inserts.length,
    failed: prepared!.failed,
    skipped: 0,
  };
}

interface PreparedBatch {
  rows: Array<{ entry: TrendingEntry; repositoryId: string }>;
  failed: Array<{ id: string; code: "not_found" | "invalid_data" | "duplicate" }>;
}

async function enrichBatch(
  pool: Pool,
  source: GitHubSource,
  entries: readonly TrendingEntry[],
  capturedAt: Date,
  options: CollectGithubTrendingOptions,
): Promise<PreparedBatch> {
  let rateLimit: { remaining: number; resetAt: Date };
  try { rateLimit = await source.getRateLimit(); }
  catch (error) { throw githubJobError(error); }
  if (!Number.isSafeInteger(rateLimit.remaining) || rateLimit.remaining < 1 || !Number.isFinite(rateLimit.resetAt.getTime())) {
    throw new JobError("rate_limit", true, "github source rate limited");
  }

  const rows: PreparedBatch["rows"] = [];
  const failed: PreparedBatch["failed"] = [];
  const githubRepoIds = new Set<number>();
  for (const entry of entries) {
    let repository;
    try {
      repository = await source.getRepository(entry.fullName);
      if (repository.fullName.toLowerCase() !== entry.fullName.toLowerCase()) {
        throw new GitHubSourceError("repository_identity_mismatch");
      }
    } catch (error) {
      if (isItemGithubError(error)) {
        failed.push({ id: entry.fullName, code: githubItemCode(error) });
        continue;
      }
      throw githubJobError(error);
    }
    if (githubRepoIds.has(repository.githubRepoId)) {
      failed.push({ id: entry.fullName, code: "duplicate" });
      continue;
    }
    githubRepoIds.add(repository.githubRepoId);
    try {
      const persisted = await createProductFromRepo(pool, repository, options, async (client, result) => {
        if (!result.repositoryCreated) return;
        await new SnapshotStore(client).insert({
          repositoryId: result.repositoryId,
          capturedAt,
          granularity: "hourly",
          stars: repository.stars,
          forks: repository.forks,
          commits30d: null,
          prTotal: null,
          prOpen: null,
          prMerged: null,
          releasesCount: null,
          issuesTotal: null,
          issuesOpen: null,
          issuesClosed: null,
          candidateBuckets: [],
          candidateRuleVersion: null,
          collectedFields: {
            core: true,
            source: "github_trending",
            source_job_run_id: options.runId ?? null,
            capacity_review_id: options.reviewedCapacityOverride ? options.capacityReviewId : null,
            capacity_status: result.capacity,
            tracked_count: result.trackedCount,
            capacity_warning: result.trackedCount >= 800,
          },
        });
      });
      rows.push({ entry, repositoryId: persisted.repositoryId });
    } catch (error) {
      if (error instanceof Error && error.message === "capacity_review_required") {
        throw new JobError("capacity_review_required", false, "repository capacity review required");
      }
      if (error instanceof Error && error.message === "capacity_hard_limit") {
        throw new JobError("capacity_hard_limit", false, "repository capacity hard limit reached");
      }
      if (error instanceof Error && /invalid|identity|private|inaccessible/.test(error.message)) {
        failed.push({ id: entry.fullName, code: "invalid_data" });
        continue;
      }
      throw new JobError("source_unavailable", true, "repository persistence unavailable");
    }
  }
  return { rows, failed };
}

function validateCollection(collection: TrendingCollection, expectedUrl: string): void {
  if (!collection || collection.sourceUrl !== expectedUrl || !Array.isArray(collection.entries) || collection.entries.length < 1 || collection.entries.length > 100) {
    throw new JobError("validation_error", false, "invalid trending source response");
  }
  const ranks = new Set<number>();
  const repositories = new Set<string>();
  for (const entry of collection.entries) {
    const identity = entry.fullName?.toLowerCase();
    if (!Number.isInteger(entry.rank) || entry.rank < 1 || entry.rank > 100 || ranks.has(entry.rank) ||
      typeof entry.fullName !== "string" || entry.fullName.length > 512 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.fullName) ||
      repositories.has(identity) || !Number.isSafeInteger(entry.starsInPeriod) || entry.starsInPeriod < 0) {
      throw new JobError("validation_error", false, "invalid trending source response");
    }
    ranks.add(entry.rank);
    repositories.add(identity);
  }
}

function isItemGithubError(error: unknown): error is GitHubSourceError {
  return error instanceof GitHubSourceError && new Set([
    "not_found", "repository_inaccessible", "repository_invalid", "repository_identity_mismatch",
  ]).has(error.code);
}

function githubItemCode(error: GitHubSourceError): "not_found" | "invalid_data" {
  return error.code === "not_found" ? "not_found" : "invalid_data";
}

function githubJobError(error: unknown): JobError {
  const code = error instanceof GitHubSourceError ? error.code : "source_unavailable";
  if (code.includes("auth")) return new JobError("authentication_error", false, "github authentication failed");
  if (code.includes("rate") || code.includes("budget")) return new JobError("rate_limit", true, "github source rate limited");
  if (code.includes("timeout")) return new JobError("timeout", true, "github source timed out");
  if (code.includes("network")) return new JobError("network_error", true, "github source unavailable");
  return new JobError("source_unavailable", true, "github source unavailable");
}

function trendingJobError(error: unknown): JobError {
  const code = error instanceof TrendingSourceError ? error.code : "source_unavailable";
  if (code === "trending_structure_invalid" || code === "trending_validation_error") {
    return new JobError("validation_error", false, "github trending structure invalid");
  }
  if (code === "rate_limit") return new JobError("rate_limit", true, "github trending rate limited");
  if (code === "timeout") return new JobError("timeout", true, "github trending timed out");
  if (code === "network_error") return new JobError("network_error", true, "github trending unavailable");
  return new JobError("source_unavailable", true, "github trending unavailable");
}

function validReviewId(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}
