import type { Pool, PoolClient } from "pg";

const sevenDaysMs = 7 * 86_400_000;

export interface XHumanReviewSample {
  postId: string;
  relevanceCorrect: boolean;
  spamDuplicateCorrect: boolean;
  sentimentCorrect?: boolean | null;
}

export interface XHumanReview {
  reviewer: string;
  reviewedAt: Date;
  samples: XHumanReviewSample[];
}

export interface EvaluateClosedCohortsOptions {
  sourceJobRunId?: string;
  xReview?: XHumanReview;
}

export interface ReviewedXResult {
  status: "reviewed";
  sampleSize: 50;
  relevanceAccuracy: number;
  spamDuplicateAccuracy: number;
  sentimentAccuracy: number | null;
  reviewer: string;
  reviewedAt: string;
}

export interface UserBehaviorMetrics {
  analyze: number;
  observe: number;
  follow: number;
  repeatWithin7d: number;
}

export interface EvaluatedCohortsResult {
  status: "evaluated";
  cohortCount: number;
  attentionPrecision: number;
  baselinePrecision: number;
  absolutePointDifference: number;
  relativeLift: number | null;
  leadTimeHours: number[];
  reportOnTimeRate: number;
  githubCoverageRate: number;
  xReview: ReviewedXResult | { status: "not_reviewed" };
  userBehavior: UserBehaviorMetrics;
  clickThroughRate: "not_measurable_in_v0_1";
  sourceJobRunId: string;
}

export interface NotEnoughHistoryResult {
  status: "not_enough_history";
  cohortCount: 0;
  oldestEligibleAt: string | null;
  sourceJobRunId: string;
}

export type ClosedCohortEvaluationResult = EvaluatedCohortsResult | NotEnoughHistoryResult;

interface ReportRow {
  id: string;
  data_cutoff_at: Date;
  structured_content: {
    report?: {
      evaluationProductIds?: unknown;
      baselineProductIds?: unknown;
    };
    sourceCandidates?: unknown;
    evaluation?: { xReview?: unknown };
  };
}

interface Cohort {
  report: ReportRow;
  cutoff: Date;
  closesAt: Date;
  recommended: string[];
  baseline: string[];
  sourceCandidates: unknown[];
}

interface CohortMetrics {
  attentionHits: number;
  attentionTotal: number;
  baselineHits: number;
  baselineTotal: number;
  attentionPrecision: number;
  baselinePrecision: number;
  absolutePointDifference: number;
  relativeLift: number | null;
  leadTimeHours: number[];
  onTime: boolean;
  covered: number;
  coverageTotal: number;
  firstTrending: Map<string, Date>;
}

export async function evaluateClosedCohorts(
  pool: Pool,
  evaluatedAt: Date,
  options: EvaluateClosedCohortsOptions = {},
): Promise<ClosedCohortEvaluationResult> {
  requireValidDate(evaluatedAt, "invalid_evaluation_time");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sourceJobRunId = await resolveSourceRunId(client, options.sourceJobRunId, evaluatedAt);
    const reports = (await client.query<ReportRow>(`select id,data_cutoff_at,structured_content
      from ace_hunter.analysis_outputs
      where output_type='daily_report' and user_id is null and product_id is null
        and status in ('complete','partial') and data_cutoff_at<=$1
      order by data_cutoff_at,id`, [evaluatedAt])).rows;
    const cohorts = reports.map(toCohort).filter((cohort) =>
      cohort.closesAt <= evaluatedAt && cohort.recommended.length > 0);

    if (cohorts.length === 0) {
      const oldestEligibleAt = reports.length === 0
        ? null
        : new Date(Math.min(...reports.map((report) => report.data_cutoff_at.getTime())) + sevenDaysMs);
      const newest = reports.at(-1);
      const evaluation = {
        status: "not_enough_history" as const,
        evaluated_at: evaluatedAt.toISOString(),
        source_job_run_id: sourceJobRunId,
        oldest_eligible_at: oldestEligibleAt?.toISOString() ?? null,
      };
      if (newest) await writeEvaluation(client, newest.id, evaluation);
      await client.query("commit");
      return {
        status: "not_enough_history",
        cohortCount: 0,
        oldestEligibleAt: oldestEligibleAt?.toISOString() ?? null,
        sourceJobRunId,
      };
    }

    const xReview = options.xReview
      ? await validateAndAggregateXReview(client, options.xReview)
      : { status: "not_reviewed" as const };
    const userBehavior = await loadUserBehavior(client, cohorts);
    const metrics: CohortMetrics[] = [];
    for (const cohort of cohorts) metrics.push(await evaluateCohort(client, cohort));

    const attentionHits = sum(metrics, "attentionHits");
    const attentionTotal = sum(metrics, "attentionTotal");
    const baselineHits = sum(metrics, "baselineHits");
    const baselineTotal = sum(metrics, "baselineTotal");
    const attentionPrecision = ratio(attentionHits, attentionTotal);
    const baselinePrecision = ratio(baselineHits, baselineTotal);
    const coverageTotal = sum(metrics, "coverageTotal");
    const aggregate = {
      status: "evaluated" as const,
      cohortCount: cohorts.length,
      attentionPrecision,
      baselinePrecision,
      absolutePointDifference: attentionPrecision - baselinePrecision,
      relativeLift: relativeLift(attentionPrecision, baselinePrecision),
      leadTimeHours: firstAppearanceLeadTimes(cohorts, metrics),
      reportOnTimeRate: ratio(metrics.filter((item) => item.onTime).length, metrics.length),
      githubCoverageRate: ratio(sum(metrics, "covered"), coverageTotal),
      xReview,
      userBehavior,
      clickThroughRate: "not_measurable_in_v0_1" as const,
      sourceJobRunId,
    };

    for (let index = 0; index < cohorts.length; index += 1) {
      const cohort = cohorts[index];
      const item = metrics[index];
      const storedReview = reviewedXResult(cohort.report.structured_content.evaluation?.xReview);
      await writeEvaluation(client, cohort.report.id, {
        status: "evaluated",
        evaluated_at: evaluatedAt.toISOString(),
        source_job_run_id: sourceJobRunId,
        window_start: cohort.cutoff.toISOString(),
        window_end: cohort.closesAt.toISOString(),
        attentionPrecision: item.attentionPrecision,
        baselinePrecision: item.baselinePrecision,
        absolutePointDifference: item.absolutePointDifference,
        relativeLift: item.relativeLift,
        leadTimeHours: item.leadTimeHours,
        reportOnTimeRate: item.onTime ? 1 : 0,
        githubCoverageRate: ratio(item.covered, item.coverageTotal),
        xReview: xReview.status === "reviewed" ? xReview : storedReview ?? xReview,
        userBehavior,
        clickThroughRate: "not_measurable_in_v0_1",
      });
    }
    await client.query("commit");
    return aggregate;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* preserve the primary error */ }
    throw error;
  } finally {
    client.release();
  }
}

function toCohort(report: ReportRow): Cohort {
  const content = report.structured_content ?? {};
  const recommended = uuidList(content.report?.evaluationProductIds, "evaluationProductIds");
  const baseline = uuidList(content.report?.baselineProductIds, "baselineProductIds");
  const cutoff = report.data_cutoff_at;
  return {
    report,
    cutoff,
    closesAt: new Date(cutoff.getTime() + sevenDaysMs),
    recommended,
    baseline,
    sourceCandidates: Array.isArray(content.sourceCandidates) ? content.sourceCandidates : [],
  };
}

async function evaluateCohort(client: PoolClient, cohort: Cohort): Promise<CohortMetrics> {
  const productIds = [...new Set([...cohort.recommended, ...cohort.baseline])];
  const firstTrending = productIds.length === 0 ? new Map<string, Date>() : new Map(
    (await client.query<{ product_id: string; first_trending_at: Date }>(`select pr.product_id,
        min(t.captured_at) first_trending_at
      from ace_hunter.product_repositories pr
      join ace_hunter.github_trending_snapshots t on t.repository_id=pr.repository_id
      join ace_hunter.job_runs source_run on source_run.id=t.job_run_id
      where pr.is_primary and pr.product_id=any($1::uuid[])
        and t.period in ('daily','weekly') and t.collection_status='success'
        and source_run.status in ('success','partial') and source_run.completed_at<=$3
        and t.captured_at>$2 and t.captured_at<=$3 and t.created_at<=$3
      group by pr.product_id`, [productIds, cohort.cutoff, cohort.closesAt])).rows
      .map((row) => [row.product_id, row.first_trending_at]),
  );
  const attentionHits = cohort.recommended.filter((id) => firstTrending.has(id)).length;
  const baselineHits = cohort.baseline.filter((id) => firstTrending.has(id)).length;
  const attentionPrecision = ratio(attentionHits, cohort.recommended.length);
  const baselinePrecision = ratio(baselineHits, cohort.baseline.length);
  const onTime = (await client.query<{ on_time: boolean }>(`select exists(
      select 1 from ace_hunter.job_runs
      where job_name='generate_report' and trigger_type='schedule'
        and scheduled_for>=$1 and scheduled_for<$1 + interval '1 day'
        and status in ('success','partial') and completed_at<=$1 + interval '45 minutes'
    ) on_time`, [cohort.cutoff])).rows[0]?.on_time === true;
  const covered = cohort.sourceCandidates.filter(isGithubCovered).length;
  return {
    attentionHits,
    attentionTotal: cohort.recommended.length,
    baselineHits,
    baselineTotal: cohort.baseline.length,
    attentionPrecision,
    baselinePrecision,
    absolutePointDifference: attentionPrecision - baselinePrecision,
    relativeLift: relativeLift(attentionPrecision, baselinePrecision),
    leadTimeHours: cohort.recommended.flatMap((productId) => {
      const trendingAt = firstTrending.get(productId);
      return trendingAt ? [(trendingAt.getTime() - cohort.cutoff.getTime()) / 3_600_000] : [];
    }).sort((left, right) => left - right),
    onTime,
    covered,
    coverageTotal: cohort.sourceCandidates.length,
    firstTrending,
  };
}

function reviewedXResult(value: unknown): ReviewedXResult | null {
  if (typeof value !== "object" || value === null) return null;
  const review = value as Partial<ReviewedXResult>;
  if (review.status !== "reviewed" || review.sampleSize !== 50 ||
      !nonnegative(review.relevanceAccuracy) || !nonnegative(review.spamDuplicateAccuracy) ||
      typeof review.reviewer !== "string" || typeof review.reviewedAt !== "string") return null;
  return review as ReviewedXResult;
}

function firstAppearanceLeadTimes(cohorts: Cohort[], metrics: CohortMetrics[]): number[] {
  const firstAppearance = new Map<string, Date>();
  const firstTrending = new Map<string, Date>();
  for (let index = 0; index < cohorts.length; index += 1) {
    for (const productId of cohorts[index].recommended) {
      const priorAppearance = firstAppearance.get(productId);
      if (!priorAppearance || cohorts[index].cutoff < priorAppearance) {
        firstAppearance.set(productId, cohorts[index].cutoff);
      }
      const trendingAt = metrics[index].firstTrending.get(productId);
      const priorTrending = firstTrending.get(productId);
      if (trendingAt && (!priorTrending || trendingAt < priorTrending)) {
        firstTrending.set(productId, trendingAt);
      }
    }
  }
  return [...firstTrending].map(([productId, trendingAt]) =>
    (trendingAt.getTime() - firstAppearance.get(productId)!.getTime()) / 3_600_000)
    .sort((left, right) => left - right);
}

async function resolveSourceRunId(
  client: PoolClient,
  requested: string | undefined,
  evaluatedAt: Date,
): Promise<string> {
  const result = requested
    ? await client.query<{ id: string }>(`select id from ace_hunter.job_runs
        where id=$1 and job_name='evaluate_success'`, [requested])
    : await client.query<{ id: string }>(`select id from ace_hunter.job_runs
        where job_name='evaluate_success' and scheduled_for<=$1
        order by scheduled_for desc,created_at desc,id desc limit 1`, [evaluatedAt]);
  if (!result.rows[0]) throw new Error("evaluate_success_source_job_run_required");
  return result.rows[0].id;
}

async function validateAndAggregateXReview(
  client: PoolClient,
  review: XHumanReview,
): Promise<ReviewedXResult> {
  if (review.reviewer.trim().length === 0 || !Number.isFinite(review.reviewedAt.getTime())) {
    throw new Error("invalid_x_human_review_metadata");
  }
  if (review.samples.length !== 50 || new Set(review.samples.map((sample) => sample.postId)).size !== 50) {
    throw new Error("x_human_review_requires_50_unique_posts");
  }
  for (const sample of review.samples) {
    if (sample.postId.trim().length === 0 || typeof sample.relevanceCorrect !== "boolean" ||
      typeof sample.spamDuplicateCorrect !== "boolean" ||
      (sample.sentimentCorrect !== undefined && sample.sentimentCorrect !== null &&
        typeof sample.sentimentCorrect !== "boolean")) {
      throw new Error("invalid_x_human_review_sample");
    }
  }
  const present = await client.query<{ count: number }>(`select count(distinct x_post_id)::int count
    from ace_hunter.product_x_posts where x_post_id=any($1::text[])`, [review.samples.map((sample) => sample.postId)]);
  if (present.rows[0]?.count !== 50) throw new Error("x_human_review_post_not_found");
  const sentiment = review.samples.filter((sample) => sample.sentimentCorrect !== undefined && sample.sentimentCorrect !== null);
  return {
    status: "reviewed",
    sampleSize: 50,
    relevanceAccuracy: ratio(review.samples.filter((sample) => sample.relevanceCorrect).length, 50),
    spamDuplicateAccuracy: ratio(review.samples.filter((sample) => sample.spamDuplicateCorrect).length, 50),
    sentimentAccuracy: sentiment.length === 0
      ? null
      : ratio(sentiment.filter((sample) => sample.sentimentCorrect).length, sentiment.length),
    reviewer: review.reviewer.trim(),
    reviewedAt: review.reviewedAt.toISOString(),
  };
}

async function loadUserBehavior(client: PoolClient, cohorts: Cohort[]): Promise<UserBehaviorMetrics> {
  const windowStart = new Date(Math.min(...cohorts.map((cohort) => cohort.cutoff.getTime())));
  const windowEnd = new Date(Math.max(...cohorts.map((cohort) => cohort.closesAt.getTime())));
  const counts = await client.query<{ analyze: number; observe: number; follow: number }>(`select
      count(*) filter(where output_type='product_analysis')::int analyze,
      count(*) filter(where output_type='realtime_observation')::int observe,
      (select count(*)::int from ace_hunter.job_runs where job_name='user_follow'
        and trigger_type='user' and status='success' and completed_at>$1 and completed_at<=$2) follow
    from ace_hunter.analysis_outputs
    where output_type in ('product_analysis','realtime_observation')
      and completed_at>$1 and completed_at<=$2`, [windowStart, windowEnd]);
  const repeats = await client.query<{ count: number }>(`with events as (
      select user_id,completed_at occurred_at from ace_hunter.analysis_outputs
      where user_id is not null and output_type in ('product_analysis','realtime_observation')
        and completed_at>$1 and completed_at<=$2
      union all
      select nullif(parameters->>'userId','')::uuid,completed_at from ace_hunter.job_runs
      where job_name='user_follow' and trigger_type='user' and status='success'
        and completed_at>$1 and completed_at<=$2 and parameters ? 'userId'
    ), repeat_users as (
      select distinct first_event.user_id from events first_event
      join events later on later.user_id=first_event.user_id
        and later.occurred_at>first_event.occurred_at
        and later.occurred_at<=first_event.occurred_at + interval '7 days'
      where first_event.user_id is not null
    ) select count(*)::int count from repeat_users`, [windowStart, windowEnd]);
  return {
    analyze: counts.rows[0]?.analyze ?? 0,
    observe: counts.rows[0]?.observe ?? 0,
    follow: counts.rows[0]?.follow ?? 0,
    repeatWithin7d: repeats.rows[0]?.count ?? 0,
  };
}

async function writeEvaluation(client: PoolClient, reportId: string, evaluation: object): Promise<void> {
  const result = await client.query(`update ace_hunter.analysis_outputs
    set structured_content=jsonb_set(structured_content,'{evaluation}',$2::jsonb,true)
    where id=$1 and output_type='daily_report'`, [reportId, JSON.stringify(evaluation)]);
  if (result.rowCount !== 1) throw new Error("daily_report_evaluation_write_conflict");
}

function uuidList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((item): item is string => typeof item === "string");
  if (ids.length !== value.length || new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))) {
    throw new Error(`invalid_daily_report_${field}`);
  }
  return ids;
}

function isGithubCovered(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { stars?: unknown; stars24hAgo?: unknown; repoAgeHours?: unknown };
  return nonnegative(candidate.stars) &&
    (nonnegative(candidate.stars24hAgo) || nonnegative(candidate.repoAgeHours));
}

function nonnegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function relativeLift(attention: number, baseline: number): number | null {
  return baseline === 0 ? null : (attention - baseline) / baseline;
}

function sum<T extends CohortMetrics>(rows: T[], key: {
  [K in keyof T]: T[K] extends number ? K : never
}[keyof T]): number {
  return rows.reduce((total, row) => total + (row[key] as number), 0);
}

function requireValidDate(value: Date, code: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(code);
}
