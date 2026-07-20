import type { Pool } from "pg";
import {
  candidateBuckets,
  maximumCandidateAgeMs,
  type CandidateBucket,
} from "../sources/github/candidate-rules.js";

export type PotentialRule = "all" | "1d" | "3d";
export type ResultLimit = number | null;

export interface PotentialListOptions {
  now: Date;
  rule: PotentialRule;
  limit: ResultLimit;
}

export interface PotentialRepository {
  repositoryId: string;
  name: string;
  fullName: string;
  description: string | null;
  owner: string;
  repositoryUrl: string;
  homepageUrl: string | null;
  createdAt: string;
  ageHours: number;
  stars: number;
  starsPerHour: number;
  forks: number | null;
  capturedAt: string;
  matchedRules: Array<Exclude<PotentialRule, "all">>;
}

export interface PotentialList {
  kind: "potential_repositories";
  rule: PotentialRule;
  generatedAt: string;
  items: PotentialRepository[];
}

interface PotentialRow {
  repository_id: string;
  name: string;
  full_name: string;
  description: string | null;
  owner_login: string;
  repo_url: string;
  homepage_url: string | null;
  github_created_at: Date;
  captured_at: Date;
  stars: string;
  forks: string | null;
}

const potentialRules = new Set<PotentialRule>(["all", "1d", "3d"]);
const bucketLabels: Record<CandidateBucket, Exclude<PotentialRule, "all">> = {
  age_1d_stars_10: "1d",
  age_3d_stars_100: "3d",
};

export async function loadPotentialRepositories(
  pool: Pool,
  options: PotentialListOptions,
): Promise<PotentialList> {
  validateOptions(options);
  const earliestCreatedAt = new Date(options.now.getTime() - maximumCandidateAgeMs);
  const result = await pool.query<PotentialRow>(`select
      r.id repository_id,r.name,r.full_name,r.description,r.owner_login,r.repo_url,r.homepage_url,
      r.github_created_at,snapshot.captured_at,snapshot.stars,snapshot.forks
    from ace_hunter.repositories r
    join lateral (
      select s.captured_at,s.stars,s.forks
      from ace_hunter.repository_snapshots s
      where s.repository_id=r.id
        and s.captured_at <= $1
        and s.created_at <= $1
        and coalesce(nullif(s.collected_fields->>'observed_at','')::timestamptz,s.created_at) <= $1
      order by s.captured_at desc,s.id desc
      limit 1
    ) snapshot on true
    where r.status='active'
      and not r.is_fork and not r.is_archived and not r.is_mirror
      and r.github_created_at between $2 and $1
      and exists (
        select 1
        from ace_hunter.product_repositories pr
        join ace_hunter.products p on p.id=pr.product_id
        where pr.repository_id=r.id and pr.is_primary and p.status='active'
      )`, [options.now, earliestCreatedAt]);

  const items = result.rows.map((row) => mapPotentialRow(row, options.now))
    .filter((item) => item.matchedRules.length > 0)
    .filter((item) => options.rule === "all" || item.matchedRules.includes(options.rule))
    .sort(comparePotentialRepositories);

  return {
    kind: "potential_repositories",
    rule: options.rule,
    generatedAt: options.now.toISOString(),
    items: options.limit === null ? items : items.slice(0, options.limit),
  };
}

export function renderPotentialList(value: PotentialList): string {
  const lines = [
    "# GitHub 潜力项目",
    "",
    `生成时间：${value.generatedAt}`,
    `筛选规则：${potentialRuleLabel(value.rule)}`,
    "",
  ];
  if (value.items.length === 0) {
    lines.push("当前没有符合条件的潜力仓库。");
    return lines.join("\n").trimEnd() + "\n";
  }

  value.items.forEach((item, index) => {
    lines.push(
      `## ${index + 1}. ${item.fullName}`,
      "",
      `- 命中规则：${item.matchedRules.map(matchedRuleLabel).join("、")}`,
      `- 简介：${item.description ?? "—"}`,
      `- 作者：${item.owner}`,
      `- 创建时间：${item.createdAt}`,
      `- 仓库年龄：${formatNumber(item.ageHours)} 小时`,
      `- Star：${item.stars}`,
      `- 平均每小时 Star：${formatNumber(item.starsPerHour)}`,
      `- Fork：${item.forks ?? "—"}`,
      `- 数据捕获时间：${item.capturedAt}`,
      `- [GitHub](${item.repositoryUrl})`,
    );
    if (item.homepageUrl !== null) lines.push(`- [演示网页](${item.homepageUrl})`);
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
}

function mapPotentialRow(row: PotentialRow, now: Date): PotentialRepository {
  const createdAt = requireDate(row.github_created_at, "createdAt");
  const capturedAt = requireDate(row.captured_at, "capturedAt");
  const stars = toSafeCount(row.stars, "stars");
  const forks = row.forks === null ? null : toSafeCount(row.forks, "forks");
  const ageHours = (now.getTime() - createdAt.getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0) throw new Error("invalid_potential_created_at");
  const matchedRules = candidateBuckets({ createdAt, stars }, now).map((bucket) => bucketLabels[bucket]);
  return {
    repositoryId: row.repository_id,
    name: row.name,
    fullName: row.full_name,
    description: row.description,
    owner: row.owner_login,
    repositoryUrl: requireWebUrl(row.repo_url, "repositoryUrl"),
    homepageUrl: row.homepage_url === null || row.homepage_url.trim() === ""
      ? null
      : requireWebUrl(row.homepage_url, "homepageUrl"),
    createdAt: createdAt.toISOString(),
    ageHours,
    stars,
    starsPerHour: stars / Math.max(ageHours, 1),
    forks,
    capturedAt: capturedAt.toISOString(),
    matchedRules,
  };
}

function comparePotentialRepositories(left: PotentialRepository, right: PotentialRepository): number {
  return right.starsPerHour - left.starsPerHour ||
    right.stars - left.stars ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    (left.fullName < right.fullName ? -1 : left.fullName > right.fullName ? 1 : 0);
}

function validateOptions(options: PotentialListOptions): void {
  if (!Number.isFinite(options.now.getTime())) throw new Error("invalid_potential_now");
  if (!potentialRules.has(options.rule)) throw new Error("invalid_potential_rule");
  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
    throw new Error("invalid_potential_limit");
  }
}

function requireDate(value: Date, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid_potential_date:${field}`);
  return date;
}

function toSafeCount(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`unsafe_potential_numeric_value:${field}`);
  return parsed;
}

function requireWebUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`invalid_potential_url:${field}`);
  }
}

function potentialRuleLabel(rule: PotentialRule): string {
  if (rule === "1d") return "1 天（24 小时内且 Star ≥ 10）";
  if (rule === "3d") return "3 天（72 小时内且 Star ≥ 100）";
  return "全部（1 天 / 3 天）";
}

function matchedRuleLabel(rule: Exclude<PotentialRule, "all">): string {
  return rule === "1d" ? "1 天（24 小时内且 Star ≥ 10）" : "3 天（72 小时内且 Star ≥ 100）";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
