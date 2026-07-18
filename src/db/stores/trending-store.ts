import type { Queryable } from "./queryable.js";

export class TrendingStore {
  public constructor(private readonly pool: Queryable) {}

  public async insert(input: {
    repositoryId: string;
    period: "daily" | "weekly" | "monthly";
    language?: string;
    capturedAt: Date;
    rank: number;
    starsInPeriod: number | null;
    sourceUrl: string;
    collectionStatus: "success" | "partial";
    jobRunId?: string | null;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.github_trending_snapshots
         (repository_id,period,language,captured_at,rank,stars_in_period,
          source_url,collection_status,job_run_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (period,language,captured_at,repository_id) do update set
         rank=excluded.rank,stars_in_period=excluded.stars_in_period,
         source_url=excluded.source_url,collection_status=excluded.collection_status,
         job_run_id=excluded.job_run_id
       returning id`,
      [
        input.repositoryId,
        input.period,
        input.language ?? "all",
        input.capturedAt,
        input.rank,
        input.starsInPeriod,
        input.sourceUrl,
        input.collectionStatus,
        input.jobRunId ?? null,
      ],
    );
    return result.rows[0].id;
  }
}
