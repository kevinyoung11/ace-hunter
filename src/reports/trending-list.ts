import type { Pool } from "pg";

export type TrendingListPeriod = "daily" | "weekly" | "monthly" | "all";
export type TrendingPeriod = Exclude<TrendingListPeriod, "all">;
export type ResultLimit = number | null;

export interface TrendingListOptions {
  now: Date;
  period: TrendingListPeriod;
  limit: ResultLimit;
}

export interface TrendingListItem {
  repositoryId: string;
  rank: number;
  name: string;
  fullName: string;
  description: string | null;
  owner: string;
  repositoryUrl: string;
  homepageUrl: string | null;
  stars: number | null;
  starsCapturedAt: string | null;
  starsInPeriod: number | null;
}

export interface AvailableTrendingList {
  period: TrendingPeriod;
  status: "available";
  capturedAt: string;
  sourceUrl: string;
  stale: boolean;
  items: TrendingListItem[];
}

export interface UnavailableTrendingList {
  period: TrendingPeriod;
  status: "unavailable";
}

export type TrendingList = AvailableTrendingList | UnavailableTrendingList;

interface TrendingListsBase {
  period: TrendingListPeriod;
  generatedAt: string;
  lists: TrendingList[];
}

export type TrendingLists =
  | (TrendingListsBase & { kind: "trending_lists" })
  | (TrendingListsBase & { kind: "not_found"; reason: "trending_unavailable" });

interface TrendingRow {
  period: string;
  captured_at: Date;
  source_url: string;
  repository_id: string;
  rank: string | number;
  stars_in_period: string | number | null;
  name: string;
  full_name: string;
  description: string | null;
  owner_login: string;
  repo_url: string;
  homepage_url: string | null;
  stars: string | number | null;
  stars_captured_at: Date | null;
}

const allPeriods: TrendingPeriod[] = ["daily", "weekly", "monthly"];
const validPeriods = new Set<TrendingListPeriod>([...allPeriods, "all"]);
const staleAfterMs = 36 * 60 * 60 * 1000;

export async function loadTrendingLists(
  pool: Pool,
  options: TrendingListOptions,
): Promise<TrendingLists> {
  validateOptions(options);
  const requestedPeriods = options.period === "all" ? allPeriods : [options.period];
  const result = await pool.query<TrendingRow>(`with candidate_batches as (
      select trending.period,trending.captured_at,
        min(trending.job_run_id::text)::uuid job_run_id,count(*)::int row_count
      from ace_hunter.github_trending_snapshots trending
      where trending.language='all'
        and trending.period=any($2::text[])
        and trending.captured_at <= $1
      group by trending.period,trending.captured_at
      having count(trending.job_run_id)=count(*)
        and count(distinct trending.job_run_id)=1
        and bool_and(trending.collection_status='success')
    ), qualified_batches as (
      select candidate.*
      from candidate_batches candidate
      join ace_hunter.job_runs run on run.id=candidate.job_run_id
      where run.job_name='collect_github_trending'
        and run.status='success'
        and run.completed_at is not null
        and run.completed_at <= $1
        and run.items_failed=0
        and run.items_succeeded=candidate.row_count
    ), latest_batches as (
      select distinct on (period) period,captured_at,job_run_id
      from qualified_batches
      order by period,captured_at desc,job_run_id desc
    )
    select trending.period,trending.captured_at,trending.source_url,
      repository.id repository_id,trending.rank,trending.stars_in_period,
      repository.name,repository.full_name,repository.description,repository.owner_login,
      repository.repo_url,repository.homepage_url,
      snapshot.stars,snapshot.effective_observed_at stars_captured_at
    from latest_batches batch
    join ace_hunter.github_trending_snapshots trending
      on trending.period=batch.period
      and trending.language='all'
      and trending.captured_at=batch.captured_at
      and trending.job_run_id=batch.job_run_id
    join ace_hunter.repositories repository on repository.id=trending.repository_id
    left join lateral (
      select fact.stars,
        coalesce(nullif(fact.collected_fields->>'observed_at','')::timestamptz,fact.created_at)
          effective_observed_at
      from ace_hunter.repository_snapshots fact
      where fact.repository_id=repository.id
        and fact.captured_at <= $1
        and fact.created_at <= $1
        and coalesce(nullif(fact.collected_fields->>'observed_at','')::timestamptz,fact.created_at) <= $1
      order by effective_observed_at desc,fact.captured_at desc,fact.created_at desc,fact.id desc
      limit 1
    ) snapshot on true
    order by trending.period,trending.rank,repository.full_name,repository.id`,
  [options.now, requestedPeriods]);

  const rowsByPeriod = new Map<TrendingPeriod, TrendingRow[]>();
  for (const row of result.rows) {
    if (!isTrendingPeriod(row.period) || !requestedPeriods.includes(row.period)) {
      throw new Error("invalid_trending_row_period");
    }
    const rows = rowsByPeriod.get(row.period) ?? [];
    rows.push(row);
    rowsByPeriod.set(row.period, rows);
  }

  const lists = requestedPeriods.map((period): TrendingList => {
    const rows = rowsByPeriod.get(period);
    if (rows === undefined || rows.length === 0) return { period, status: "unavailable" };
    const capturedAt = requireDate(rows[0].captured_at, "capturedAt");
    const sourceUrl = requireWebUrl(rows[0].source_url, "sourceUrl");
    const items = rows
      .map(mapTrendingRow)
      .sort(compareTrendingItems);
    return {
      period,
      status: "available",
      capturedAt: capturedAt.toISOString(),
      sourceUrl,
      stale: options.now.getTime() - capturedAt.getTime() > staleAfterMs,
      items: options.limit === null ? items : items.slice(0, options.limit),
    };
  });
  const base: TrendingListsBase = {
    period: options.period,
    generatedAt: options.now.toISOString(),
    lists,
  };
  return lists.every((list) => list.status === "unavailable")
    ? { ...base, kind: "not_found", reason: "trending_unavailable" }
    : { ...base, kind: "trending_lists" };
}

export function renderTrendingLists(value: TrendingLists): string {
  const lines = [
    value.period === "all" ? "# GitHub Trending 日榜 / 周榜 / 月榜" : `# GitHub Trending ${periodLabel(value.period)}`,
    "",
    `生成时间：${value.generatedAt}`,
    "",
  ];
  for (const list of value.lists) {
    lines.push(`## ${periodLabel(list.period)}`, "");
    if (list.status === "unavailable") {
      lines.push(`${periodLabel(list.period)}当前不可用：没有可验证的完整采集批次。`, "");
      continue;
    }
    lines.push(
      `- 榜单捕获时间：${list.capturedAt}`,
      `- [榜单来源](<${list.sourceUrl}>)`,
    );
    if (list.stale) lines.push("- 该榜单数据可能已过期（超过 36 小时）。");
    lines.push("");
    if (list.items.length === 0) {
      lines.push("该完整批次没有可展示的仓库。", "");
      continue;
    }
    for (const item of list.items) {
      lines.push(
        `### ${item.rank}. ${markdownText(item.fullName)}`,
        "",
        `- 简介：${item.description === null ? "—" : markdownText(item.description) || "—"}`,
        `- 作者：${markdownText(item.owner)}`,
        `- 总 Star：${formatStarFact(item)}`,
        `- 周期新增 Star：${item.starsInPeriod ?? "—"}`,
        `- [GitHub](<${item.repositoryUrl}>)`,
      );
      if (item.homepageUrl !== null) lines.push(`- [演示网页](<${item.homepageUrl}>)`);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

function mapTrendingRow(row: TrendingRow): TrendingListItem {
  const stars = row.stars === null ? null : toSafeCount(row.stars, "stars");
  const starsCapturedAt = row.stars_captured_at === null
    ? null
    : requireDate(row.stars_captured_at, "starsCapturedAt").toISOString();
  return {
    repositoryId: row.repository_id,
    rank: toPositiveSafeCount(row.rank, "rank"),
    name: row.name,
    fullName: row.full_name,
    description: row.description,
    owner: row.owner_login,
    repositoryUrl: requireWebUrl(row.repo_url, "repositoryUrl"),
    homepageUrl: row.homepage_url === null || row.homepage_url.trim() === ""
      ? null
      : requireWebUrl(row.homepage_url, "homepageUrl"),
    stars,
    starsCapturedAt,
    starsInPeriod: row.stars_in_period === null
      ? null
      : toSafeCount(row.stars_in_period, "starsInPeriod"),
  };
}

function compareTrendingItems(left: TrendingListItem, right: TrendingListItem): number {
  return left.rank - right.rank ||
    (left.fullName < right.fullName ? -1 : left.fullName > right.fullName ? 1 : 0) ||
    (left.repositoryId < right.repositoryId ? -1 : left.repositoryId > right.repositoryId ? 1 : 0);
}

function validateOptions(options: TrendingListOptions): void {
  if (!Number.isFinite(options.now.getTime())) throw new Error("invalid_trending_now");
  if (!validPeriods.has(options.period)) throw new Error("invalid_trending_period");
  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
    throw new Error("invalid_trending_limit");
  }
}

function isTrendingPeriod(value: string): value is TrendingPeriod {
  return allPeriods.includes(value as TrendingPeriod);
}

function requireDate(value: Date, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid_trending_date:${field}`);
  return date;
}

function toPositiveSafeCount(value: string | number, field: string): number {
  const count = toSafeCount(value, field);
  if (count < 1) throw new Error(`unsafe_trending_numeric_value:${field}`);
  return count;
}

function toSafeCount(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`unsafe_trending_numeric_value:${field}`);
  return parsed;
}

function requireWebUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`invalid_trending_url:${field}`);
  }
}

function periodLabel(period: TrendingListPeriod): string {
  if (period === "daily") return "日榜";
  if (period === "weekly") return "周榜";
  if (period === "monthly") return "月榜";
  return "日榜 / 周榜 / 月榜";
}

function formatStarFact(item: TrendingListItem): string {
  return item.stars === null || item.starsCapturedAt === null
    ? "—（暂无不晚于生成时间的 Star 事实）"
    : `${item.stars}（事实时间：${item.starsCapturedAt}）`;
}

function markdownText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").replace(/([\\`*_[\]{}()#+\-.!|<>])/g, "\\$1");
}
