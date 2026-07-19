import type { Pool, PoolClient } from "pg";

export interface CompactionResult { snapshotsDeleted: number; jobRunsDeleted: number }

export async function compactSnapshots(pool: Pool, now: Date): Promise<CompactionResult> {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_retention_time");
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended('ace_hunter_retention',0))");
    await createDailySurvivors(client, cutoff);
    const snapshots = await client.query(`delete from ace_hunter.repository_snapshots h
      where h.granularity='hourly' and h.captured_at<$1
        and exists(select 1 from ace_hunter.repository_snapshots d
          where d.repository_id=h.repository_id and d.granularity='daily'
            and d.captured_at=(date_trunc('day',h.captured_at at time zone 'UTC') at time zone 'UTC'))`, [cutoff]);
    const jobs = await client.query(`delete from ace_hunter.job_runs
      where created_at<$1 and status in ('success','partial','failed')`, [cutoff]);
    await client.query("commit");
    return { snapshotsDeleted: snapshots.rowCount ?? 0, jobRunsDeleted: jobs.rowCount ?? 0 };
  } catch (error) {
    try { await client.query("rollback"); } catch { /* preserve primary failure */ }
    throw error;
  } finally { client.release(); }
}

async function createDailySurvivors(client: PoolClient, cutoff: Date): Promise<void> {
  await client.query(`insert into ace_hunter.repository_snapshots
      (repository_id,captured_at,granularity,stars,forks,commits_30d,pr_total,pr_open,pr_merged,
       releases_count,latest_release_at,latest_release_tag,issues_total,issues_open,issues_closed,
       aux_metrics_captured_at,candidate_buckets,candidate_rule_version,collected_fields)
    select distinct on(repository_id,(captured_at at time zone 'UTC')::date)
      repository_id,(date_trunc('day',captured_at at time zone 'UTC') at time zone 'UTC'),'daily',stars,forks,commits_30d,pr_total,pr_open,pr_merged,
      releases_count,latest_release_at,latest_release_tag,issues_total,issues_open,issues_closed,
      aux_metrics_captured_at,candidate_buckets,candidate_rule_version,
      jsonb_set(collected_fields,'{compacted_source_captured_at}',to_jsonb(captured_at::text),true)
    from ace_hunter.repository_snapshots
    where granularity='hourly' and captured_at<$1
    order by repository_id,(captured_at at time zone 'UTC')::date,captured_at desc,id desc
    on conflict(repository_id,captured_at,granularity) do update set
      stars=excluded.stars,forks=excluded.forks,commits_30d=excluded.commits_30d,pr_total=excluded.pr_total,
      pr_open=excluded.pr_open,pr_merged=excluded.pr_merged,releases_count=excluded.releases_count,
      latest_release_at=excluded.latest_release_at,latest_release_tag=excluded.latest_release_tag,
      issues_total=excluded.issues_total,issues_open=excluded.issues_open,issues_closed=excluded.issues_closed,
      aux_metrics_captured_at=excluded.aux_metrics_captured_at,candidate_buckets=excluded.candidate_buckets,
      candidate_rule_version=excluded.candidate_rule_version,collected_fields=excluded.collected_fields
    where coalesce((ace_hunter.repository_snapshots.collected_fields->>'compacted_source_captured_at')::timestamptz,'-infinity')
      < (excluded.collected_fields->>'compacted_source_captured_at')::timestamptz`, [cutoff]);
}
