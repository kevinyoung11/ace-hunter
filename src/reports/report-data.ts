import type { Pool } from "pg";

export type ReportTrendingPeriod = "daily" | "weekly" | "monthly";
export type ReportXStatus = "success_with_results" | "success_empty" | "unavailable";
export type XRunStatus = "success" | "partial" | "unavailable";

export interface ReportCandidate {
  productId: string;
  repositoryId: string;
  stars: number;
  stars24hAgo: number | null;
  repoAgeHours: number;
  xStatus: ReportXStatus;
  xPosts: number;
  xAuthors: number;
  xEngagement: number;
  trending: ReportTrendingPeriod[];
  candidateAtCutoff: boolean;
  firstTrendingAt: Date | null;
  preTrendingEligible: boolean;
}

interface CandidateRow {
  product_id: string;
  repository_id: string;
  stars: string;
  stars_24h_ago: string | null;
  repo_age_hours: string;
  x_status: ReportXStatus;
  x_posts: number;
  x_authors: number;
  x_engagement: string;
  trending: ReportTrendingPeriod[];
  candidate_at_cutoff: boolean;
  first_trending_at: Date | null;
}

export async function loadXRunStatus(pool: Pool, cutoff: Date): Promise<XRunStatus> {
  requireValidCutoff(cutoff);
  const result = await pool.query<{ status: XRunStatus }>(`with eligible as (
      select status,scheduled_for from ace_hunter.job_runs
      where job_name='collect_x_posts' and status in ('success','partial','failed')
        and scheduled_for <= $1 and completed_at <= $1
    ), latest_batch as (select max(scheduled_for) scheduled_for from eligible)
    select case
      when bool_and(e.status='success') then 'success'
      when bool_or(e.status in ('success','partial')) then 'partial'
      else 'unavailable'
    end status
    from eligible e join latest_batch b using(scheduled_for)`, [cutoff]);
  return result.rows[0]?.status ?? "unavailable";
}

export async function loadReportCandidates(pool: Pool, cutoff: Date): Promise<ReportCandidate[]> {
  requireValidCutoff(cutoff);
  const result = await pool.query<CandidateRow>(`with
    primary_repo as (
      select product_id,repository_id
      from ace_hunter.product_repositories
      where is_primary
    ),
    eligible_snapshots as (
      select s.* from ace_hunter.repository_snapshots s
      where s.captured_at <= $1
        and coalesce(nullif(s.collected_fields->>'observed_at','')::timestamptz,s.created_at) <= $1
    ),
    latest_snapshot as (
      select distinct on (s.repository_id) s.repository_id,s.stars
      from eligible_snapshots s
      join primary_repo pr on pr.repository_id=s.repository_id
      order by s.repository_id,s.captured_at desc,s.id desc
    ),
    reference_snapshot as (
      select pr.repository_id,reference.stars
      from primary_repo pr
      left join lateral (
        select s.stars
        from eligible_snapshots s
        where s.repository_id=pr.repository_id
          and s.captured_at between $1 - interval '25 hours 30 minutes'
                                and $1 - interval '22 hours 30 minutes'
        order by abs(extract(epoch from (s.captured_at - ($1 - interval '24 hours')))),
                 s.captured_at desc,s.id desc
        limit 1
      ) reference on true
    ),
    eligible_trending as (
      select t.* from ace_hunter.github_trending_snapshots t
      left join ace_hunter.job_runs j on j.id=t.job_run_id
      where t.captured_at <= $1 and (
        (t.job_run_id is null and t.created_at <= $1) or
        (t.job_run_id is not null and j.status in ('success','partial','failed') and j.completed_at <= $1)
      )
    ),
    complete_trending_batches as (
      select period,language,captured_at
      from eligible_trending
      group by period,language,captured_at
      having bool_and(collection_status='success')
    ),
    latest_trending_batches as (
      select period,language,max(captured_at) captured_at
      from complete_trending_batches
      group by period,language
    ),
    current_trend as (
      select distinct t.repository_id,t.period
      from eligible_trending t
      join latest_trending_batches b using(period,language,captured_at)
      where t.collection_status='success'
    ),
    current_trend_agg as (
      select repository_id,
        array_agg(period order by case period when 'daily' then 1 when 'weekly' then 2 else 3 end)::text[] trending
      from current_trend
      group by repository_id
    ),
    first_trend as (
      select t.repository_id,min(t.captured_at) first_trending_at
      from eligible_trending t
      join complete_trending_batches b using(period,language,captured_at)
      where t.collection_status='success'
      group by t.repository_id
    ),
    x_aggregate as (
      select product_id,count(*)::integer x_posts,count(distinct author_id)::integer x_authors,
        coalesce(sum(likes+reposts+quotes+replies+coalesce(bookmarks,0)),0)::bigint x_engagement
      from ace_hunter.product_x_posts
      where post_type in ('original','article')
        and not is_duplicate
        and relevance_score >= 0.6
        and x_created_at <= $1
        and analyzed_at <= $1
        and first_seen_at <= $1
        and coalesce(metrics_updated_at,first_seen_at) <= $1
      group by product_id
    ),
    facts as (
      select p.id product_id,r.id repository_id,latest.stars,reference.stars stars_24h_ago,
        extract(epoch from ($1-r.github_created_at))/3600 repo_age_hours,
        case
          when product_x_run.status='success' and coalesce(product_x_run.items_expected,0)>0 then 'success_with_results'
          when product_x_run.status='success' then 'success_empty'
          when product_x_run.status in ('partial','failed') then 'unavailable'
          when product_x_run.status is null and p.x_last_attempted_at <= $1
            and p.x_collection_status='success_with_results' then 'success_with_results'
          when product_x_run.status is null and p.x_last_attempted_at <= $1
            and p.x_collection_status='success_empty' then 'success_empty'
          else 'unavailable'
        end x_status,
        coalesce(x.x_posts,0) x_posts,coalesce(x.x_authors,0) x_authors,
        coalesce(x.x_engagement,0) x_engagement,
        coalesce(trend.trending,'{}'::text[]) trending,first.first_trending_at,
        (r.github_created_at <= $1 and (
          ($1-r.github_created_at <= interval '1 day' and latest.stars>=10) or
          ($1-r.github_created_at <= interval '7 days' and latest.stars>=100) or
          ($1-r.github_created_at <= interval '30 days' and latest.stars>=1000)
        )) candidate_at_cutoff
      from ace_hunter.products p
      join primary_repo pr on pr.product_id=p.id
      join ace_hunter.repositories r on r.id=pr.repository_id
      join latest_snapshot latest on latest.repository_id=r.id
      left join reference_snapshot reference on reference.repository_id=r.id
      left join current_trend_agg trend on trend.repository_id=r.id
      left join first_trend first on first.repository_id=r.id
      left join lateral (
        select jr.status,jr.items_expected
        from ace_hunter.job_runs jr
        where jr.job_name='collect_x_posts'
          and jr.parameters->>'productId'=p.id::text
          and jr.status in ('success','partial','failed')
          and jr.scheduled_for <= $1 and jr.completed_at <= $1
        order by jr.scheduled_for desc,jr.completed_at desc,jr.id desc
        limit 1
      ) product_x_run on true
      left join x_aggregate x on x.product_id=p.id
      where p.status='active' and r.status='active' and r.github_created_at <= $1
    )
    select * from facts
    where candidate_at_cutoff or cardinality(trending)>0
    order by product_id`, [cutoff]);

  return result.rows.map((row) => ({
    productId: row.product_id,
    repositoryId: row.repository_id,
    stars: toSafeInteger(row.stars, "stars"),
    stars24hAgo: row.stars_24h_ago === null ? null : toSafeInteger(row.stars_24h_ago, "stars24hAgo"),
    repoAgeHours: toFiniteNonnegative(row.repo_age_hours, "repoAgeHours"),
    xStatus: row.x_status,
    xPosts: toSafeInteger(row.x_posts, "xPosts"),
    xAuthors: toSafeInteger(row.x_authors, "xAuthors"),
    xEngagement: toSafeInteger(row.x_engagement, "xEngagement"),
    trending: row.trending,
    candidateAtCutoff: row.candidate_at_cutoff,
    firstTrendingAt: row.first_trending_at,
    preTrendingEligible: row.first_trending_at === null,
  }));
}

function requireValidCutoff(cutoff: Date): void {
  if (!Number.isFinite(cutoff.getTime())) throw new Error("invalid_report_cutoff");
}

function toSafeInteger(value: number | string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`unsafe_report_numeric_value:${field}`);
  return parsed;
}

function toFiniteNonnegative(value: number | string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`unsafe_report_numeric_value:${field}`);
  return parsed;
}
