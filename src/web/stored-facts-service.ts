import { randomUUID } from "node:crypto";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pool } from "pg";

export type WebOutput = Record<string, unknown> & { kind?: string };
export type TrendingPeriod = "daily" | "weekly" | "monthly";
export type TrendingOutput =
  | {
      kind: "trending";
      period: TrendingPeriod;
      items: Array<{
        rank: number;
        fullName: string;
        repoUrl: string;
        language: string;
        starsInPeriod: number | null;
        stars: number | null;
        capturedAt: string;
      }>;
    }
  | {
      kind: "not_found";
      reason: "trending_unavailable";
      period: TrendingPeriod;
    };

export interface StoredFactsService {
  today(): Promise<WebOutput>;
  trending(period: TrendingPeriod): Promise<TrendingOutput>;
  analyze(target: string): Promise<WebOutput>;
  listMonitors(): Promise<WebOutput>;
  follow(target: string): Promise<WebOutput>;
  unfollow(target: string): Promise<WebOutput>;
}

export function createStoredFactsService({ pool, userId }: { pool: Pool; userId: string }): StoredFactsService {
  async function resolve(target: string) {
    const input = target.trim();
    const github = githubTarget(input);
    const rows = github
      ? (await pool.query<{ id: string; name: string }>(`select p.id,p.name from ace_hunter.products p join ace_hunter.product_repositories pr on pr.product_id=p.id and pr.is_primary join ace_hunter.repositories r on r.id=pr.repository_id where p.status='active' and r.status='active' and lower(r.full_name)=lower($1) order by p.name,p.id`, [github])).rows
      : (await pool.query<{ id: string; name: string }>("select id,name from ace_hunter.products where status='active' and lower(name)=lower($1) order by name,id", [input])).rows;
    if (rows.length === 1) return { kind: "found" as const, productId: rows[0].id, name: rows[0].name };
    if (rows.length > 1) return { kind: "ambiguous" as const, candidates: rows };
    return { kind: "not_found" as const };
  }
  return {
    async today() {
      const row = (await pool.query<{ id: string; status: string; data_cutoff_at: Date; structured_content: unknown }>("select id,status,data_cutoff_at,structured_content from ace_hunter.analysis_outputs where output_type='daily_report' and status in ('complete','partial') order by period_end desc,completed_at desc,id desc limit 1")).rows[0];
      return row ? { kind: "daily_report", id: row.id, status: row.status, dataCutoffAt: row.data_cutoff_at.toISOString(), content: row.structured_content } : { kind: "not_found", reason: "daily_report_unavailable" };
    },
    async trending(period): Promise<TrendingOutput> {
      const rows = (await pool.query<{ rank: number; full_name: string; repo_url: string; language: string; stars_in_period: string | null; stars: string | null; captured_at: Date }>(`with latest_batch as (
        select max(captured_at) captured_at
        from ace_hunter.github_trending_snapshots
        where period=$1
      )
      select t.rank,r.full_name,r.repo_url,t.language,t.stars_in_period,s.stars,t.captured_at
      from ace_hunter.github_trending_snapshots t
      join latest_batch b on b.captured_at=t.captured_at
      join ace_hunter.repositories r on r.id=t.repository_id
      left join lateral (
        select stars from ace_hunter.repository_snapshots
        where repository_id=t.repository_id
        order by captured_at desc,id desc
        limit 1
      ) s on true
      where t.period=$1
      order by t.rank asc,t.id asc`, [period])).rows;
      if (rows.length === 0) return { kind: "not_found", reason: "trending_unavailable", period };
      return { kind: "trending", period, items: rows.map((row) => ({ rank: row.rank, fullName: row.full_name, repoUrl: row.repo_url, language: row.language, starsInPeriod: row.stars_in_period === null ? null : Number(row.stars_in_period), stars: row.stars === null ? null : Number(row.stars), capturedAt: row.captured_at.toISOString() })) };
    },
    async analyze(target) {
      const found = await resolve(target); if (found.kind !== "found") return found;
      const cutoff = new Date();
      const row = (await pool.query<any>(`select p.id product_id,p.name,r.repo_url,r.homepage_url,coalesce(nullif(s.collected_fields->>'observed_at','')::timestamptz,s.created_at) observed_at,s.stars,s.forks,p.x_collection_status x_status,(select count(*)::int from ace_hunter.product_x_posts x where x.product_id=p.id and x.post_type in ('original','article') and not x.is_duplicate and x.relevance_score>=0.6 and x.analyzed_at<=$2 and x.x_created_at<=$2) x_posts from ace_hunter.products p join ace_hunter.product_repositories pr on pr.product_id=p.id and pr.is_primary join ace_hunter.repositories r on r.id=pr.repository_id join lateral (select * from ace_hunter.repository_snapshots snapshot where snapshot.repository_id=r.id and snapshot.captured_at<=$2 order by snapshot.captured_at desc,snapshot.id desc limit 1) s on true where p.id=$1 and p.status='active' and r.status='active'`, [found.productId, cutoff])).rows[0];
      if (!row) return { kind: "not_found", reason: "product_facts_unavailable" };
      const xAvailable = row.x_status === "success_with_results" || row.x_status === "success_empty";
      const report = { outputType: "product_analysis", dataCutoffAt: cutoff.toISOString(), status: xAvailable ? "complete" : "partial", item: { productId: row.product_id, name: row.name, repositoryUrl: row.repo_url, homepageUrl: row.homepage_url, capturedAt: row.observed_at.toISOString(), conclusion: "基于已采集事实生成的当前产品观察", score: { attentionScore: null }, githubFacts: { stars: Number(row.stars), forks: row.forks === null ? null : Number(row.forks) }, xFacts: xAvailable ? { status: row.x_status, posts: row.x_posts } : { status: "unavailable" }, representativePosts: [], risks: xAvailable ? [] : ["X 数据源不完整"] }, completedSources: xAvailable ? ["github", "x"] : ["github"], missingSources: xAvailable ? [] : ["x"] };
      const id = (await pool.query<{ id: string }>(`insert into ace_hunter.analysis_outputs(output_type,user_id,product_id,period_start,period_end,data_cutoff_at,status,title,summary,structured_content,rendered_markdown,analysis_version,trigger_type,started_at,completed_at) values('product_analysis',$1,$2,$3,$3,$3,$4,$5,$6,$7::jsonb,'','product-report-v1','manual',$3,$3) on conflict (output_type,product_id,period_start,period_end) where output_type='product_analysis' and product_id is not null do update set structured_content=excluded.structured_content,status=excluded.status,completed_at=excluded.completed_at returning id`, [userId, found.productId, cutoff, report.status, `产品分析：${row.name}`, report.item.conclusion, JSON.stringify({ report })])).rows[0].id;
      return { kind: "product_analysis", analysisId: id, status: report.status, content: { report } };
    },
    async listMonitors() {
      const monitors = (await pool.query(`select m.id "monitorId",m.product_id "productId",p.name,m.status,m.started_at "startedAt",m.last_observed_at "lastObservedAt" from ace_hunter.user_product_monitors m join ace_hunter.products p on p.id=m.product_id where m.user_id=$1 order by (m.status='active') desc,p.name,p.id`, [userId])).rows;
      return { monitors };
    },
    async follow(target) { return setMonitor(pool, userId, await resolve(target), true); },
    async unfollow(target) { return setMonitor(pool, userId, await resolve(target), false); },
  };
}

function githubTarget(value: string): string | null { const match = value.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/); return match?.[1] ?? null; }
async function setMonitor(pool: Pool, userId: string, resolution: Awaited<ReturnType<StoredFactsService["analyze"]>> extends never ? never : { kind: string; productId?: string }, active: boolean): Promise<WebOutput> {
  if (resolution.kind !== "found" || !resolution.productId) return resolution;
  const client = await pool.connect(); const now = new Date();
  try { await client.query("begin"); const id = (await client.query<{ id: string }>("insert into ace_hunter.user_product_monitors(user_id,product_id,status,started_at,updated_at) values($1,$2,$3,$4,$4) on conflict(user_id,product_id) do update set status=excluded.status,updated_at=excluded.updated_at returning id", [userId, resolution.productId, active ? "active" : "inactive", now])).rows[0].id; await client.query("insert into ace_hunter.job_runs(job_name,trigger_type,scheduled_for,parameters,status,started_at,completed_at,items_expected,items_succeeded,items_failed,items_skipped,idempotency_key) values($1,'user',$2,$3,'success',$2,$2,1,1,0,0,$4)", [active ? "user_follow" : "user_unfollow", now, JSON.stringify({ userId, productId: resolution.productId }), `${active ? "user_follow" : "user_unfollow"}:${userId}:${resolution.productId}:${randomUUID()}`]); await client.query("commit"); return { kind: active ? "followed" : "unfollowed", productId: resolution.productId, monitorId: id, status: active ? "active" : "inactive" }; } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}
