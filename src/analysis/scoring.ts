import { cumeDist } from "./percentiles.js";

export type XStatus =
  | "success_with_results"
  | "success_empty"
  | "unavailable";
export type XRunStatus = "success" | "partial" | "unavailable";
export type TrendingPeriod = "daily" | "weekly" | "monthly";

export interface ScoreInput {
  productId: string;
  snapshotObservedAt?: Date;
  stars: number;
  stars24hAgo: number | null;
  repoAgeHours: number;
  xStatus: XStatus;
  xPosts: number;
  xAuthors: number;
  xEngagement: number;
  trending: TrendingPeriod[];
  trendingRanks?: Partial<Record<TrendingPeriod, number>>;
}

export interface ScoreOutput extends ScoreInput {
  deltaStars24h: number | null;
  growthRate24h: number | null;
  githubMomentum: number;
  xAttention: number | null;
  trendingSignal: number;
  attentionScore: number;
}

const COUNT_FIELDS = [
  "stars",
  "stars24hAgo",
  "xPosts",
  "xAuthors",
  "xEngagement",
] as const;

function validateInput(input: readonly ScoreInput[]): void {
  const productIds = new Set<string>();
  for (const item of input) {
    if (item.productId.trim().length === 0) {
      throw new TypeError("productId must not be empty");
    }
    if (productIds.has(item.productId)) {
      throw new TypeError(`duplicate productId: ${item.productId}`);
    }
    productIds.add(item.productId);

    for (const field of COUNT_FIELDS) {
      const value = item[field];
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(`${field} must be a non-negative safe integer`);
      }
    }
    if (!Number.isFinite(item.repoAgeHours) || item.repoAgeHours < 0) {
      throw new RangeError("repoAgeHours must be a finite non-negative number");
    }
    if (
      item.xStatus === "success_empty" &&
      (item.xPosts !== 0 || item.xAuthors !== 0 || item.xEngagement !== 0)
    ) {
      throw new RangeError("success_empty requires zero X metrics");
    }
    if (
      item.xStatus !== "unavailable" &&
      item.xAuthors > item.xPosts
    ) {
      throw new RangeError("X authors cannot exceed X posts");
    }
  }
}

function trendSignal(periods: readonly TrendingPeriod[]): number {
  if (periods.includes("daily")) return 100;
  if (periods.includes("weekly")) return 70;
  if (periods.includes("monthly")) return 40;
  return 0;
}

function compareScore(left: ScoreOutput, right: ScoreOutput): number {
  if (left.attentionScore !== right.attentionScore) {
    return right.attentionScore - left.attentionScore;
  }
  if (left.stars !== right.stars) {
    return right.stars - left.stars;
  }
  return left.productId < right.productId
    ? -1
    : left.productId > right.productId
      ? 1
      : 0;
}

export function rankCandidates(
  input: readonly ScoreInput[],
  xRunStatus: XRunStatus,
): ScoreOutput[] {
  validateInput(input);

  const momentumDeltaValues = input.map((item) =>
    item.stars24hAgo === null
      ? item.stars / Math.max(item.repoAgeHours, 6)
      : item.stars - item.stars24hAgo,
  );
  const momentumGrowthValues = input.map((item, index) =>
    item.stars24hAgo === null
      ? momentumDeltaValues[index]
      : momentumDeltaValues[index] / Math.max(item.stars24hAgo, 20),
  );
  const deltaPercentiles = cumeDist(momentumDeltaValues);
  const growthPercentiles = cumeDist(momentumGrowthValues);

  const successfulXIndexes = input.flatMap((item, index) =>
    item.xStatus === "unavailable" ? [] : [index],
  );
  const xPercentiles = (field: "xPosts" | "xAuthors" | "xEngagement") => {
    const percentiles = cumeDist(
      successfulXIndexes.map((index) => input[index][field]),
    );
    return new Map(
      successfulXIndexes.map((index, position) => [
        index,
        percentiles[position],
      ]),
    );
  };
  const postPercentiles = xPercentiles("xPosts");
  const authorPercentiles = xPercentiles("xAuthors");
  const engagementPercentiles = xPercentiles("xEngagement");

  return input
    .map((item, index): ScoreOutput => {
      const githubMomentum =
        0.6 * deltaPercentiles[index] + 0.4 * growthPercentiles[index];
      const xAttention =
        item.xStatus === "unavailable"
          ? null
          : item.xPosts === 0
            ? 0
            : 0.5 * postPercentiles.get(index)! +
              0.3 * authorPercentiles.get(index)! +
              0.2 * engagementPercentiles.get(index)!;
      const trendingSignal = trendSignal(item.trending);
      const attentionScore =
        xRunStatus === "unavailable"
          ? 0.875 * githubMomentum + 0.125 * trendingSignal
          : 0.7 * githubMomentum +
            0.2 * (xAttention ?? 0) +
            0.1 * trendingSignal;

      return {
        ...item,
        deltaStars24h:
          item.stars24hAgo === null ? null : momentumDeltaValues[index],
        growthRate24h:
          item.stars24hAgo === null ? null : momentumGrowthValues[index],
        githubMomentum,
        xAttention,
        trendingSignal,
        attentionScore,
      };
    })
    .sort(compareScore);
}
