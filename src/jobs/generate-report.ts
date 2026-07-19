import type { Pool } from "pg";
import { rankCandidates } from "../analysis/scoring.js";
import { representativePosts } from "../analysis/representative-posts.js";
import { AnalysisOutputStore } from "../db/stores/analysis-output-store.js";
import {
  loadReportCandidates,
  loadXRunStatus,
  type ReportCandidate,
  type XRunStatus,
} from "../reports/report-data.js";
import {
  buildDailyReport,
  type DailyReport,
  type SummaryClaim,
} from "../reports/daily-report.js";
import { renderDailyReport } from "../reports/markdown-renderer.js";

export interface ReportEvidencePost {
  url: string;
  category: string;
  engagement: number;
  createdAt: Date;
  authorId: string;
  isProjectAffiliated: boolean;
  sentiment: "positive" | "neutral" | "negative" | null;
}

export interface ReportEvidence {
  name: string;
  description: string | null;
  repoUrl: string | null;
  homepageUrl: string | null;
  representativePosts: ReportEvidencePost[];
}

export interface GenerateReportDependencies {
  pool: Pool;
  now?: () => Date;
  loadCandidates?: (pool: Pool, cutoff: Date) => Promise<ReportCandidate[]>;
  loadXRunStatus?: (pool: Pool, cutoff: Date) => Promise<XRunStatus>;
  loadEvidence?: (
    pool: Pool,
    productIds: string[],
    cutoff: Date,
  ) => Promise<Map<string, ReportEvidence>>;
  summaryClaims?: (
    candidates: ReportCandidate[],
    evidence: Map<string, ReportEvidence>,
    cutoff: Date,
  ) => Promise<SummaryClaim[]>;
}

export interface GeneratedReport {
  id: string;
  status: "complete" | "partial";
  report: DailyReport;
  markdown: string;
}

export async function generateReport(
  dependencies: GenerateReportDependencies,
  cutoff: Date,
): Promise<GeneratedReport> {
  assertCutoff(cutoff);
  const frozenInput = await loadFrozenInput(dependencies.pool, cutoff);
  const candidates = frozenInput?.candidates ?? await (dependencies.loadCandidates ?? loadReportCandidates)(
      dependencies.pool,
      cutoff,
    );
  const xRunStatus = frozenInput?.xRunStatus ?? await (dependencies.loadXRunStatus ?? loadXRunStatus)(
      dependencies.pool,
      cutoff,
    );
  const evidence = frozenInput?.evidence ?? await (dependencies.loadEvidence ?? loadReportEvidence)(
      dependencies.pool,
      candidates.map((candidate) => candidate.productId),
      cutoff,
    );
  const ranked = rankCandidates(candidates, xRunStatus);
  const claims = frozenInput?.claims ?? verifySummaryEvidence(
    await (dependencies.summaryClaims ?? noSummaryClaims)(candidates, evidence, cutoff),
    evidence,
  );

  const report = buildDailyReport({
    dataCutoffAt: cutoff,
    facts: {
      scannedRepos: candidates.length,
      xCoveredRepos: xRunStatus === "unavailable"
        ? 0
        : candidates.filter((candidate) => candidate.xStatus !== "unavailable").length,
    },
    candidates: ranked.map((candidate, index) => {
      const itemEvidence = evidence.get(candidate.productId);
      const xStatus = xRunStatus === "unavailable" ? "unavailable" : candidate.xStatus;
      return {
        productId: candidate.productId,
        name: itemEvidence?.name ?? candidate.productId,
        repositoryUrl: itemEvidence?.repoUrl ?? undefined,
        homepageUrl: itemEvidence?.homepageUrl,
        capturedAt: candidate.snapshotObservedAt?.toISOString(),
        ranks: {
          overall: index + 1,
          daily: candidate.trendingRanks?.daily ?? null,
          weekly: candidate.trendingRanks?.weekly ?? null,
          monthly: candidate.trendingRanks?.monthly ?? null,
        },
        conclusion: conclusionFor(candidate.attentionScore, candidate.trending),
        score: {
          attentionScore: candidate.attentionScore,
          githubMomentum: candidate.githubMomentum,
          xAttention: candidate.xAttention,
          trendingSignal: candidate.trendingSignal,
        },
        githubFacts: {
          stars: candidate.stars,
          stars24hAgo: candidate.stars24hAgo,
          deltaStars24h: candidate.deltaStars24h,
          growthRate24h: candidate.growthRate24h,
          trending: candidate.trending,
          repoUrl: itemEvidence?.repoUrl ?? null,
          homepageUrl: itemEvidence?.homepageUrl ?? null,
        },
        xFacts: xStatus === "unavailable"
          ? { status: "unavailable" }
          : {
              status: xStatus,
              posts: candidate.xPosts,
              authors: candidate.xAuthors,
              engagement: candidate.xEngagement,
              sentiment: sentimentCounts(itemEvidence?.representativePosts ?? []),
            },
        representativePosts: xStatus === "unavailable"
          ? []
          : representativePosts(itemEvidence?.representativePosts ?? []),
        risks: risksFor(candidate, xStatus),
      };
    }),
    summaryClaims: claims,
    evaluationProductIds: ranked
      .slice(0, 10)
      .filter((candidate) => candidates.find((item) => item.productId === candidate.productId)?.preTrendingEligible)
      .map((candidate) => candidate.productId),
    baselineProductIds: [...candidates]
      .filter((candidate) => candidate.preTrendingEligible)
      .sort((left, right) => right.stars - left.stars || left.productId.localeCompare(right.productId))
      .slice(0, 10)
      .map((candidate) => candidate.productId),
  });
  const markdown = renderDailyReport(report);
  const status = xRunStatus === "success" ? "complete" : "partial";
  const periodStart = new Date(cutoff.getTime() - 86_400_000);
  const now = dependencies.now?.() ?? new Date();
  const id = await new AnalysisOutputStore(dependencies.pool).upsert({
    outputType: "daily_report",
    periodStart,
    periodEnd: cutoff,
    dataCutoffAt: cutoff,
    status,
    title: "今日值得关注",
    summary: report.platformSummary,
    structuredContent: {
      report,
      evidence: freezeEvidence(evidence),
      sourceCandidates: freezeCandidates(candidates),
      sourceXRunStatus: xRunStatus,
      sourceSummaryClaims: claims,
    },
    renderedMarkdown: markdown,
    analysisVersion: "report-v1",
    triggerType: "schedule",
    startedAt: now,
    completedAt: now,
  });
  return { id, status, report, markdown };
}

export async function loadReportEvidence(
  pool: Pool,
  productIds: string[],
  cutoff: Date,
): Promise<Map<string, ReportEvidence>> {
  assertCutoff(cutoff);
  if (productIds.length === 0) return new Map();
  const products = await pool.query<{
    product_id: string;
    name: string;
    description: string | null;
    repo_url: string | null;
    homepage_url: string | null;
  }>(`select p.id product_id,
        coalesce(snapshot.collected_fields#>>'{metadata,name}',p.id::text) name,
        snapshot.collected_fields#>>'{metadata,description}' description,
        snapshot.collected_fields#>>'{metadata,repo_url}' repo_url,
        snapshot.collected_fields#>>'{metadata,homepage_url}' homepage_url
      from ace_hunter.products p
      join ace_hunter.product_repositories pr on pr.product_id=p.id and pr.is_primary
      join ace_hunter.repositories r on r.id=pr.repository_id
      join lateral (
        select s.collected_fields
        from ace_hunter.repository_snapshots s
        where s.repository_id=r.id and s.captured_at<=$2
          and coalesce(nullif(s.collected_fields->>'observed_at','')::timestamptz,s.created_at)<=$2
        order by s.captured_at desc,s.id desc limit 1
      ) snapshot on true
      where p.id=any($1::uuid[])`, [productIds, cutoff]);
  const posts = await pool.query<{
    product_id: string;
    post_url: string;
    topic: string | null;
    engagement: string;
    x_created_at: Date;
    author_id: string;
    is_project_affiliated: boolean | null;
    sentiment: "positive" | "neutral" | "negative" | null;
  }>(`select product_id,post_url,topic,
        (likes+reposts+quotes+replies+coalesce(bookmarks,0))::bigint engagement,
        x_created_at,author_id,is_project_affiliated,sentiment
      from ace_hunter.product_x_posts
      where product_id=any($1::uuid[]) and post_type in ('original','article')
        and not is_duplicate and relevance_score>=0.6
        and x_created_at<=$2 and analyzed_at<=$2 and first_seen_at<=$2
        and coalesce(metrics_updated_at,first_seen_at)<=$2`, [productIds, cutoff]);
  const result = new Map<string, ReportEvidence>();
  for (const product of products.rows) {
    result.set(product.product_id, {
      name: product.name,
      description: product.description,
      repoUrl: product.repo_url,
      homepageUrl: product.homepage_url,
      representativePosts: [],
    });
  }
  for (const post of posts.rows) {
    const target = result.get(post.product_id);
    if (!target) continue;
    target.representativePosts.push({
      url: post.post_url,
      category: categoryFor(post.topic, post.is_project_affiliated === true),
      engagement: safeInteger(post.engagement, "engagement"),
      createdAt: post.x_created_at,
      authorId: post.author_id,
      isProjectAffiliated: post.is_project_affiliated === true,
      sentiment: post.sentiment,
    });
  }
  return result;
}

function conclusionFor(score: number, trending: readonly string[]): string {
  if (trending.length > 0) return "已进入 GitHub Trending，值得持续观察";
  if (score >= 75) return "增长与讨论信号较强，值得优先观察";
  return "具备早期信号，建议继续观察";
}

function risksFor(
  candidate: Pick<ReportCandidate, "stars24hAgo" | "trending">,
  xStatus: string,
): string[] {
  const risks: string[] = [];
  if (candidate.stars24hAgo === null) risks.push("缺少可比较的 24 小时 Star 快照");
  if (xStatus === "unavailable") risks.push("X 数据源不完整");
  if (candidate.trending.length > 0) risks.push("已进入榜单，不能作为榜前预测样本");
  return risks;
}

function sentimentCounts(posts: ReportEvidencePost[]): Record<string, number> {
  return posts.reduce<Record<string, number>>((counts, post) => {
    if (post.sentiment) counts[post.sentiment] = (counts[post.sentiment] ?? 0) + 1;
    return counts;
  }, {});
}

function categoryFor(topic: string | null, affiliated: boolean): string {
  if (affiliated) return "project_launch";
  if (topic?.toLowerCase().includes("usage")) return "real_usage";
  return "independent_analysis";
}

function freezeEvidence(evidence: Map<string, ReportEvidence>): Record<string, unknown> {
  return Object.fromEntries([...evidence].map(([productId, value]) => [
    productId,
    {
      ...value,
      representativePosts: value.representativePosts.map((post) => ({
        ...post,
        createdAt: post.createdAt.toISOString(),
      })),
    },
  ]));
}

async function loadFrozenInput(
  pool: Pool,
  cutoff: Date,
): Promise<{ candidates: ReportCandidate[]; evidence: Map<string, ReportEvidence>; xRunStatus: XRunStatus; claims: SummaryClaim[] } | null> {
  const row = await pool.query<{
    evidence: Record<string, FrozenEvidence> | null;
    candidates: FrozenCandidate[] | null;
    x_run_status: XRunStatus | null;
    claims: SummaryClaim[] | null;
  }>(
    `select structured_content->'evidence' evidence,
            structured_content->'sourceCandidates' candidates,
            structured_content->>'sourceXRunStatus' x_run_status,
            structured_content->'sourceSummaryClaims' claims
       from ace_hunter.analysis_outputs
      where output_type='daily_report' and user_id is null and product_id is null
        and period_start=$1 and period_end=$2 and data_cutoff_at=$2
      limit 1`,
    [new Date(cutoff.getTime() - 86_400_000), cutoff],
  );
  const frozen = row.rows[0];
  if (!frozen?.evidence || !frozen.candidates || !frozen.x_run_status || !frozen.claims) return null;
  const evidence = new Map(Object.entries(frozen.evidence).map(([productId, value]) => [productId, {
    ...value,
    representativePosts: value.representativePosts.map((post) => ({
      ...post,
      createdAt: new Date(post.createdAt),
    })),
  }]));
  const candidates = frozen.candidates.map((candidate) => ({
    ...candidate,
    snapshotObservedAt: new Date(candidate.snapshotObservedAt),
    firstTrendingAt: candidate.firstTrendingAt === null ? null : new Date(candidate.firstTrendingAt),
  }));
  return { candidates, evidence, xRunStatus: frozen.x_run_status, claims: frozen.claims };
}

interface FrozenEvidence extends Omit<ReportEvidence, "representativePosts"> {
  representativePosts: Array<Omit<ReportEvidencePost, "createdAt"> & { createdAt: string }>;
}

type FrozenCandidate = Omit<ReportCandidate, "snapshotObservedAt" | "firstTrendingAt"> & {
  snapshotObservedAt: string;
  firstTrendingAt: string | null;
};

function freezeCandidates(candidates: ReportCandidate[]): FrozenCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    snapshotObservedAt: candidate.snapshotObservedAt.toISOString(),
    firstTrendingAt: candidate.firstTrendingAt?.toISOString() ?? null,
  }));
}

function verifySummaryEvidence(
  claims: SummaryClaim[],
  evidence: Map<string, ReportEvidence>,
): SummaryClaim[] {
  const allowed = new Set<string>();
  for (const [productId, value] of evidence) {
    for (const post of value.representativePosts) {
      allowed.add(`${productId}\u0000${post.authorId}\u0000${post.isProjectAffiliated}`);
    }
  }
  return claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.filter((item) =>
      allowed.has(`${item.productId}\u0000${item.authorId}\u0000${item.isProjectAffiliated}`)),
  }));
}

async function noSummaryClaims(): Promise<SummaryClaim[]> {
  return [];
}

function safeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`unsafe_report_numeric_value:${field}`);
  }
  return parsed;
}

function assertCutoff(cutoff: Date): void {
  if (!Number.isFinite(cutoff.getTime())) throw new Error("invalid_report_cutoff");
  if (
    cutoff.getUTCHours() !== 0 || cutoff.getUTCMinutes() !== 0 ||
    cutoff.getUTCSeconds() !== 0 || cutoff.getUTCMilliseconds() !== 0
  ) {
    throw new Error("daily_report_cutoff_must_be_08_00_asia_shanghai");
  }
}
