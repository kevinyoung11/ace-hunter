import type { Pool } from "pg";
import { utcHourBucket } from "../core/time-buckets.js";
import { SnapshotStore } from "../db/stores/snapshot-store.js";
import { createProductFromRepo, type CapacityReviewOptions, type ProductFromRepoResult } from "../products/create-product-from-repo.js";
import type { GitHubRepository, GitHubSource, GitHubSourceFactory } from "../sources/github/github-source.js";
import { GitHubSourceError } from "../sources/github/github-source.js";
import { candidateBuckets, searchCompletely } from "../sources/github/repository-search.js";
import { JobError, type JobResult } from "./job-runner.js";

export interface OperationalEvent { code: "capacity_warning"; trackedCount: number }
export interface DiscoverGithubDependencies {
  pool: Pool;
  sourceFactory: GitHubSourceFactory;
  emitOperationalEvent: (event: OperationalEvent) => void | Promise<void>;
}
export interface DiscoverGithubOptions extends CapacityReviewOptions { runId?: string }

const day = 86_400_000;

export async function discoverGithubCandidates(
  dependencies: DiscoverGithubDependencies,
  at: Date,
  options: DiscoverGithubOptions = {},
): Promise<JobResult> {
  let source;
  try { source = await dependencies.sourceFactory.openOperation(); }
  catch (error) { throw toJobError(error); }
  let result: JobResult | undefined;
  let primaryError: unknown;
  try { result = await discoverWithOperation(dependencies, source, at, options); }
  catch (error) { primaryError = error; }
  try { await source.close(); }
  catch {
    if (primaryError === undefined) throw new JobError("source_unavailable", true, "github operation close failed");
  }
  if (primaryError !== undefined) throw primaryError;
  return result!;
}

async function discoverWithOperation(
  dependencies: DiscoverGithubDependencies,
  source: GitHubSource,
  at: Date,
  options: DiscoverGithubOptions,
): Promise<JobResult> {
  if (!Number.isFinite(at.getTime())) throw new JobError("validation_error", false, "invalid discovery time");
  const searchAt = new Date(Math.floor(at.getTime() / 1_000) * 1_000);
  if (options.reviewedCapacityOverride === true && (!options.capacityReviewId || !options.runId)) {
    throw new JobError("validation_error", false, "capacity review audit required");
  }
  let rateLimit: { remaining: number; resetAt: Date };
  try { rateLimit = await source.getRateLimit(); }
  catch (error) { throw toJobError(error); }
  if (rateLimit.remaining < 1) throw new JobError("rate_limit", true, "github search rate limited");

  const rules = [
    { from: new Date(searchAt.getTime() - day), to: searchAt, minStars: 10 },
    { from: new Date(searchAt.getTime() - 7 * day), to: searchAt, minStars: 100 },
    { from: new Date(searchAt.getTime() - 30 * day), to: searchAt, minStars: 1_000 },
  ];
  const found = new Map<number, GitHubRepository>();
  try {
    for (const rule of rules) {
      for (const repository of await searchCompletely(source, rule)) {
        const previous = found.get(repository.githubRepoId);
        if (previous && previous.fullName !== repository.fullName) throw new Error("repository_identity_conflict");
        found.set(repository.githubRepoId, repository);
      }
    }
  } catch (error) {
    throw toJobError(error);
  }

  const failed: Array<{ id: string; code: string }> = [];
  let succeeded = 0;
  let skipped = 0;
  for (const searchRepository of found.values()) {
    let repository: GitHubRepository;
    try {
      repository = await source.getRepository(searchRepository.fullName);
      if (repository.githubRepoId !== searchRepository.githubRepoId || repository.nodeId !== searchRepository.nodeId) {
        throw new GitHubSourceError("repository_identity_mismatch");
      }
    } catch (error) {
      if (systemicError(error)) throw toJobError(error);
      pushFailure(failed, { id: safeItemId(searchRepository), code: itemFailureCode(error) });
      continue;
    }
    let buckets: string[];
    try { buckets = candidateBuckets(repository, at); }
    catch { pushFailure(failed, { id: safeItemId(searchRepository), code: "invalid_data" }); continue; }
    if (!eligible(repository, buckets)) { skipped += 1; continue; }
    let created: ProductFromRepoResult;
    try {
      created = await createProductFromRepo(dependencies.pool, repository, options, async (client, persisted) => {
        await new SnapshotStore(client).insert({
          repositoryId: persisted.repositoryId, capturedAt: utcHourBucket(at), granularity: "hourly",
          stars: repository.stars, forks: repository.forks, commits30d: null, prTotal: null,
          prOpen: null, prMerged: null, releasesCount: null, issuesTotal: null, issuesOpen: null,
          issuesClosed: null, candidateBuckets: buckets, candidateRuleVersion: "v1",
          collectedFields: {
            core: true,
            source_job_run_id: options.runId ?? null,
            capacity_review_id: options.reviewedCapacityOverride ? options.capacityReviewId : null,
            capacity_status: persisted.capacity,
            tracked_count: persisted.trackedCount,
            capacity_warning: persisted.trackedCount >= 800,
          },
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === "capacity_review_required") {
        throw new JobError("capacity_review_required", false, "repository capacity review required");
      }
      if (error instanceof Error && error.message === "capacity_hard_limit") {
        throw new JobError("capacity_hard_limit", false, "repository capacity hard limit reached");
      }
      pushFailure(failed, { id: safeItemId(repository), code: itemFailureCode(error) });
      continue;
    }
    succeeded += 1;
    if (created.repositoryCreated && created.trackedCount >= 800) {
      try { await dependencies.emitOperationalEvent({ code: "capacity_warning", trackedCount: created.trackedCount }); }
      catch { /* best-effort structured log; durable evidence is in the committed snapshot */ }
    }
  }
  return { expected: found.size, succeeded, failed, skipped };
}

function eligible(repository: GitHubRepository, buckets: string[]): boolean {
  return repository.visibility === "public" && !repository.isPrivate &&
    !repository.isFork && !repository.isArchived && !repository.isMirror &&
    Boolean(repository.description?.trim() || repository.hasReadme) && buckets.length > 0;
}

function safeItemId(repository: GitHubRepository): string {
  return Number.isSafeInteger(repository.githubRepoId) ? String(repository.githubRepoId) : "invalid_repository";
}

function itemFailureCode(error: unknown): "rate_limit" | "not_found" | "invalid_data" | "item_failed" {
  const code = error instanceof GitHubSourceError ? error.code : error instanceof Error ? error.message : "";
  if (code.includes("rate")) return "rate_limit";
  if (code.includes("404") || code.includes("not_found")) return "not_found";
  if (code.includes("invalid") || code.includes("identity") || code.includes("private") || code.includes("capacity")) return "invalid_data";
  return "item_failed";
}

function pushFailure(failed: Array<{ id: string; code: string }>, item: { id: string; code: string }): void {
  if (failed.length >= 1_000) throw new JobError("validation_error", false, "too many failed github items");
  failed.push(item);
}

function systemicError(error: unknown): boolean {
  if (!(error instanceof GitHubSourceError)) return false;
  return !new Set(["not_found", "repository_inaccessible", "repository_invalid", "repository_identity_mismatch"]).has(error.code);
}

function toJobError(error: unknown): JobError {
  const code = error instanceof GitHubSourceError ? error.code : "source_unavailable";
  if (code.includes("rate") || code.includes("budget")) return new JobError("rate_limit", true, "github source rate limited");
  if (code.includes("auth")) return new JobError("authentication_error", false, "github authentication failed");
  if (code.includes("timeout")) return new JobError("timeout", true, "github source timed out");
  if (code.includes("network")) return new JobError("network_error", true, "github source unavailable");
  return new JobError("source_unavailable", true, "github source unavailable");
}
