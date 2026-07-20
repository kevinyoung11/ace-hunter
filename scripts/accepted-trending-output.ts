import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import {
  candidateBuckets,
  maximumCandidateAgeMs,
  type CandidateBucket,
} from "../src/sources/github/candidate-rules.js";

const periods = ["daily", "weekly", "monthly"] as const;
const staleAfterMs = 36 * 60 * 60 * 1000;
type Period = typeof periods[number];
const isoDate = z.string().datetime({ offset: true });
const nullableWebUrl = z.string().url().nullable();
const trendingItem = z.object({
  repositoryId: z.string().min(1), rank: z.number().int().positive(), name: z.string().min(1),
  fullName: z.string().min(1), description: z.string().nullable(), owner: z.string().min(1),
  repositoryUrl: z.string().url(), homepageUrl: nullableWebUrl,
  stars: z.number().int().nonnegative().nullable(), starsCapturedAt: isoDate.nullable(),
  starsInPeriod: z.number().int().nonnegative().nullable(),
}).strict();
const available = z.object({
  period: z.enum(periods), status: z.literal("available"), capturedAt: isoDate,
  sourceUrl: z.string().url(), stale: z.boolean(), items: z.array(trendingItem),
}).strict();
const trendingPayload = z.object({
  kind: z.literal("trending_lists"), period: z.enum([...periods, "all"]), generatedAt: isoDate,
  lists: z.array(available),
}).strict();
const potentialItem = z.object({
  repositoryId: z.string().min(1), name: z.string().min(1), fullName: z.string().min(1),
  description: z.string().nullable(), owner: z.string().min(1), repositoryUrl: z.string().url(),
  homepageUrl: nullableWebUrl, createdAt: isoDate, ageHours: z.number().nonnegative(),
  stars: z.number().int().nonnegative(), starsPerHour: z.number().nonnegative(),
  forks: z.number().int().nonnegative().nullable(), capturedAt: isoDate,
  matchedRules: z.array(z.enum(["1d", "3d"])).min(1),
}).strict();
const potentialPayload = z.object({
  kind: z.literal("potential_repositories"), rule: z.literal("all"), generatedAt: isoDate,
  items: z.array(potentialItem),
}).strict();

export interface AcceptedTrendingBatch {
  period: string;
  capturedAt: Date;
  jobRunId: string;
}

export interface AcceptedSignalOutputOptions {
  pool: Pick<Pool, "query">;
  smokeDir: string;
  expectedSmokeDir: string;
  batches: AcceptedTrendingBatch[];
}

interface TrendingDatabaseRow {
  rank: string | number;
  stars_in_period: string | number | null;
  source_url: string;
  repository_id: string;
  name: string;
  full_name: string;
  description: string | null;
  owner_login: string;
  repo_url: string;
  homepage_url: string | null;
  stars: string | number | null;
  stars_captured_at: Date | null;
}

interface PotentialDatabaseRow {
  repository_id: string;
  name: string;
  full_name: string;
  description: string | null;
  owner_login: string;
  repo_url: string;
  homepage_url: string | null;
  github_created_at: Date;
  effective_observed_at: Date;
  stars: string | number;
  forks: string | number | null;
}

const bucketLabels: Record<CandidateBucket, "1d" | "3d"> = {
  age_1d_stars_10: "1d",
  age_3d_stars_100: "3d",
};

export async function verifyAcceptedSignalOutput(options: AcceptedSignalOutputOptions): Promise<void> {
  const smokeDir = await validateSmokeDirectory(options.smokeDir, options.expectedSmokeDir);
  const batchMap = validateBatches(options.batches);
  const singles = new Map<Period, z.infer<typeof trendingPayload>>();
  for (const period of periods) {
    const value = trendingPayload.parse(await readArtifact(smokeDir, period));
    if (value.period !== period || value.lists.length !== 1 || value.lists[0]?.period !== period) {
      throw new Error(`accepted_trending_payload_invalid:${period}`);
    }
    await assertTrendingSection(options.pool, value.lists[0], new Date(value.generatedAt), batchMap.get(period)!);
    singles.set(period, value);
  }
  const all = trendingPayload.parse(await readArtifact(smokeDir, "all"));
  if (all.period !== "all" || JSON.stringify(all.lists.map((list) => list.period)) !== JSON.stringify(periods)) {
    throw new Error("accepted_trending_payload_invalid:all");
  }
  for (const list of all.lists) {
    await assertTrendingSection(options.pool, list, new Date(all.generatedAt), batchMap.get(list.period)!);
    const single = singles.get(list.period)?.lists[0];
    if (single === undefined ||
        JSON.stringify(canonicalTrendingSection(single)) !== JSON.stringify(canonicalTrendingSection(list))) {
      throw new Error(`accepted_trending_payload_mismatch:${list.period}`);
    }
  }
  const potential = potentialPayload.parse(await readArtifact(smokeDir, "potential"));
  await assertPotential(options.pool, potential);
}

async function assertTrendingSection(
  pool: Pick<Pool, "query">,
  actual: z.infer<typeof available>,
  generatedAt: Date,
  batch: AcceptedTrendingBatch,
) {
  if (actual.capturedAt !== batch.capturedAt.toISOString()) {
    throw new Error(`accepted_trending_capture_mismatch:${actual.period}`);
  }
  const ageMs = generatedAt.getTime() - batch.capturedAt.getTime();
  if (ageMs < 0 || ageMs > staleAfterMs || actual.stale !== (ageMs > staleAfterMs)) {
    throw new Error(`accepted_trending_stale:${actual.period}`);
  }
  const result = await pool.query<TrendingDatabaseRow>(`/* accepted_trending_facts */
    select trending.rank,trending.stars_in_period,trending.source_url,
      repository.id repository_id,repository.name,repository.full_name,repository.description,
      repository.owner_login,repository.repo_url,repository.homepage_url,
      snapshot.stars,snapshot.effective_observed_at stars_captured_at
    from ace_hunter.github_trending_snapshots trending
    join ace_hunter.repositories repository on repository.id=trending.repository_id
    left join lateral (
      select fact.stars,
        coalesce(nullif(fact.collected_fields->>'observed_at','')::timestamptz,fact.created_at)
          effective_observed_at
      from ace_hunter.repository_snapshots fact
      where fact.repository_id=repository.id and fact.captured_at <= $4 and fact.created_at <= $4
        and coalesce(nullif(fact.collected_fields->>'observed_at','')::timestamptz,fact.created_at) <= $4
      order by effective_observed_at desc,fact.captured_at desc,fact.created_at desc,fact.id desc limit 1
    ) snapshot on true
    where trending.period=$1 and trending.captured_at=$2 and trending.job_run_id=$3
      and trending.language='all' and trending.collection_status='success'
    order by trending.rank,repository.full_name,repository.id limit 20`,
  [actual.period, batch.capturedAt, batch.jobRunId, generatedAt]);
  if (result.rows.length === 0 || actual.items.length === 0) {
    throw new Error(`accepted_trending_items_empty:${actual.period}`);
  }
  const sourceUrl = requireWebUrl(result.rows[0].source_url);
  const expected = {
    period: actual.period,
    status: "available",
    capturedAt: batch.capturedAt.toISOString(),
    sourceUrl,
    stale: false,
    items: result.rows.map(mapTrendingRow),
  };
  if (JSON.stringify(canonicalTrendingSection(actual)) !== JSON.stringify(expected)) {
    throw new Error(`accepted_trending_facts_mismatch:${actual.period}`);
  }
}

async function assertPotential(pool: Pick<Pool, "query">, actual: z.infer<typeof potentialPayload>) {
  const at = new Date(actual.generatedAt);
  const earliest = new Date(at.getTime() - maximumCandidateAgeMs);
  const result = await pool.query<PotentialDatabaseRow>(`/* accepted_potential_facts */
    select repository.id repository_id,repository.name,repository.full_name,repository.description,
      repository.owner_login,repository.repo_url,repository.homepage_url,repository.github_created_at,
      snapshot.effective_observed_at,snapshot.stars,snapshot.forks
    from ace_hunter.repositories repository
    join lateral (
      select fact.stars,fact.forks,
        coalesce(nullif(fact.collected_fields->>'observed_at','')::timestamptz,fact.created_at)
          effective_observed_at
      from ace_hunter.repository_snapshots fact
      where fact.repository_id=repository.id and fact.captured_at <= $1 and fact.created_at <= $1
        and coalesce(nullif(fact.collected_fields->>'observed_at','')::timestamptz,fact.created_at) <= $1
      order by effective_observed_at desc,fact.captured_at desc,fact.created_at desc,fact.id desc limit 1
    ) snapshot on true
    where repository.status='active' and not repository.is_fork and not repository.is_archived
      and not repository.is_mirror and repository.github_created_at between $2 and $1
      and exists (select 1 from ace_hunter.product_repositories link
        join ace_hunter.products product on product.id=link.product_id
        where link.repository_id=repository.id and link.is_primary and product.status='active')`, [at, earliest]);
  const expected = result.rows.map((row) => mapPotentialRow(row, at))
    .filter((item) => item.matchedRules.length > 0)
    .sort(comparePotential)
    .slice(0, 20);
  if (JSON.stringify(actual.items.map(canonicalPotentialItem)) !== JSON.stringify(expected)) {
    throw new Error("accepted_potential_facts_mismatch");
  }
}

function mapTrendingRow(row: TrendingDatabaseRow) {
  return {
    repositoryId: row.repository_id,
    rank: safeCount(row.rank, false),
    name: row.name,
    fullName: row.full_name,
    description: row.description,
    owner: row.owner_login,
    repositoryUrl: requireWebUrl(row.repo_url),
    homepageUrl: row.homepage_url === null || row.homepage_url.trim() === "" ? null : requireWebUrl(row.homepage_url),
    stars: row.stars === null ? null : safeCount(row.stars),
    starsCapturedAt: row.stars_captured_at === null ? null : requireDate(row.stars_captured_at).toISOString(),
    starsInPeriod: row.stars_in_period === null ? null : safeCount(row.stars_in_period),
  };
}

function mapPotentialRow(row: PotentialDatabaseRow, at: Date) {
  const createdAt = requireDate(row.github_created_at);
  const capturedAt = requireDate(row.effective_observed_at);
  const stars = safeCount(row.stars);
  const ageHours = (at.getTime() - createdAt.getTime()) / 3_600_000;
  const matchedRules = candidateBuckets({ createdAt, stars }, at).map((bucket) => bucketLabels[bucket]);
  return {
    repositoryId: row.repository_id, name: row.name, fullName: row.full_name, description: row.description,
    owner: row.owner_login, repositoryUrl: requireWebUrl(row.repo_url),
    homepageUrl: row.homepage_url === null || row.homepage_url.trim() === "" ? null : requireWebUrl(row.homepage_url),
    createdAt: createdAt.toISOString(), ageHours, stars, starsPerHour: stars / Math.max(ageHours, 1),
    forks: row.forks === null ? null : safeCount(row.forks), capturedAt: capturedAt.toISOString(), matchedRules,
  };
}

function canonicalTrendingSection(value: z.infer<typeof available>) {
  return {
    period: value.period, status: value.status, capturedAt: value.capturedAt,
    sourceUrl: value.sourceUrl, stale: value.stale,
    items: value.items.map((item) => ({
    repositoryId: item.repositoryId, rank: item.rank, name: item.name, fullName: item.fullName,
    description: item.description, owner: item.owner, repositoryUrl: item.repositoryUrl,
    homepageUrl: item.homepageUrl, stars: item.stars, starsCapturedAt: item.starsCapturedAt,
    starsInPeriod: item.starsInPeriod,
    })),
  };
}

function canonicalPotentialItem(item: z.infer<typeof potentialItem>) {
  return {
    repositoryId: item.repositoryId, name: item.name, fullName: item.fullName, description: item.description,
    owner: item.owner, repositoryUrl: item.repositoryUrl, homepageUrl: item.homepageUrl,
    createdAt: item.createdAt, ageHours: item.ageHours, stars: item.stars, starsPerHour: item.starsPerHour,
    forks: item.forks, capturedAt: item.capturedAt, matchedRules: item.matchedRules,
  };
}

function comparePotential(left: ReturnType<typeof mapPotentialRow>, right: ReturnType<typeof mapPotentialRow>) {
  return right.starsPerHour - left.starsPerHour || right.stars - left.stars ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    (left.fullName < right.fullName ? -1 : left.fullName > right.fullName ? 1 : 0);
}

async function validateSmokeDirectory(smokeDirInput: string, expectedInput: string) {
  const smokeDir = resolve(smokeDirInput);
  if (smokeDir !== resolve(expectedInput)) throw new Error("accepted_signal_smoke_path_invalid");
  const directory = await lstat(smokeDir).catch(() => null);
  if (directory === null || !directory.isDirectory() || directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
    throw new Error("accepted_signal_smoke_path_invalid");
  }
  return smokeDir;
}

function validateBatches(rows: AcceptedTrendingBatch[]) {
  const result = new Map<Period, AcceptedTrendingBatch>();
  for (const row of rows) {
    if (!isPeriod(row.period) || !Number.isFinite(row.capturedAt.getTime()) || !z.string().uuid().safeParse(row.jobRunId).success ||
        result.has(row.period)) throw new Error("accepted_trending_batches_invalid");
    result.set(row.period, row);
  }
  if (result.size !== periods.length) throw new Error("accepted_trending_batches_invalid");
  return result;
}

async function readArtifact(smokeDir: string, name: Period | "all" | "potential") {
  const path = join(smokeDir, `${name}.json`);
  const value = await lstat(path).catch(() => null);
  if (value === null || !value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() ||
      (value.mode & 0o077) !== 0) throw new Error(`accepted_signal_artifact_invalid:${name}`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`accepted_signal_payload_invalid:${name}`); }
}

function safeCount(value: string | number, allowZero = true) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error("accepted_signal_numeric_invalid");
  return parsed;
}

function requireDate(value: Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("accepted_signal_date_invalid");
  return date;
}

function requireWebUrl(value: string) {
  const url = new URL(value);
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
    throw new Error("accepted_signal_url_invalid");
  }
  return url.toString();
}

function isPeriod(value: string): value is Period {
  return periods.includes(value as Period);
}
