export type XEvidenceStatus = "success" | "success_with_results" | "success_empty" | "partial" | "unavailable";

export interface ReportPostLink {
  readonly url: string;
  readonly category: string;
}

export interface ReportRanks {
  readonly overall?: number | null;
  readonly daily?: number | null;
  readonly weekly?: number | null;
  readonly monthly?: number | null;
}

export interface DailyReportItem {
  readonly productId: string;
  readonly name?: string;
  readonly repositoryUrl?: string;
  readonly homepageUrl?: string | null;
  readonly capturedAt?: string;
  readonly conclusion: string;
  readonly score: Readonly<Record<string, number | null>>;
  readonly ranks?: ReportRanks;
  readonly githubFacts: Readonly<Record<string, unknown>>;
  readonly xFacts: Readonly<{ status?: XEvidenceStatus } & Record<string, unknown>>;
  readonly representativePosts: readonly ReportPostLink[];
  readonly risks: readonly string[];
}

export interface DailyReport {
  readonly dataCutoffAt: string;
  readonly facts: Readonly<Record<string, number>>;
  readonly platformSummary: string | null;
  readonly items: readonly DailyReportItem[];
  readonly evaluationProductIds: readonly string[];
  readonly baselineProductIds: readonly string[];
}

export interface SummaryEvidence {
  readonly productId: string;
  readonly authorId: string;
  readonly isProjectAffiliated: boolean;
}

export interface SummaryClaim {
  readonly text: string;
  readonly evidence: readonly SummaryEvidence[];
}

export interface DailyReportInput {
  readonly dataCutoffAt: Date;
  readonly facts: Readonly<Record<string, number>>;
  readonly candidates: readonly DailyReportItem[];
  readonly summaryClaims: readonly SummaryClaim[];
  readonly evaluationProductIds: readonly string[];
  readonly baselineProductIds: readonly string[];
}

function isSupported(claim: SummaryClaim): boolean {
  const productIds = new Set(claim.evidence.map((entry) => entry.productId).filter(Boolean));
  const independentAuthors = new Set(
    claim.evidence
      .filter((entry) => !entry.isProjectAffiliated)
      .map((entry) => entry.authorId)
      .filter(Boolean),
  );
  return claim.text.trim().length > 0 && (productIds.size >= 2 || independentAuthors.size >= 3);
}

function copyItem(item: DailyReportItem): DailyReportItem {
  return {
    ...item,
    score: { ...item.score },
    ranks: item.ranks === undefined ? undefined : { ...item.ranks },
    githubFacts: { ...item.githubFacts },
    xFacts: { ...item.xFacts },
    representativePosts: item.representativePosts.slice(0, 2).map((post) => ({ ...post })),
    risks: [...item.risks],
  };
}

function finiteScore(item: DailyReportItem): number {
  const value = item.score.attentionScore;
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function stars(item: DailyReportItem): number {
  const value = item.githubFacts.stars;
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

export function buildDailyReport(input: DailyReportInput): DailyReport {
  if (!Number.isFinite(input.dataCutoffAt.getTime())) throw new Error("dataCutoffAt must be a valid date");
  const supportedSummary = input.summaryClaims
    .filter(isSupported)
    .map((claim) => claim.text.trim())
    .join("；")
    .slice(0, 200);
  const items = [...input.candidates]
    .sort((left, right) => finiteScore(right) - finiteScore(left) || stars(right) - stars(left) || left.productId.localeCompare(right.productId))
    .slice(0, 10)
    .map(copyItem);

  return {
    dataCutoffAt: input.dataCutoffAt.toISOString(),
    facts: { ...input.facts },
    platformSummary: supportedSummary || null,
    items,
    evaluationProductIds: [...input.evaluationProductIds],
    baselineProductIds: [...input.baselineProductIds],
  };
}
