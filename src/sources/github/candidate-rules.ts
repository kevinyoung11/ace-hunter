const dayMs = 86_400_000;

export const candidateRuleVersion = "v2" as const;

export const candidateRules = [
  { bucket: "age_1d_stars_10", maximumAgeMs: dayMs, minimumStars: 10 },
  { bucket: "age_3d_stars_100", maximumAgeMs: 3 * dayMs, minimumStars: 100 },
] as const;

export type CandidateRule = (typeof candidateRules)[number];
export type CandidateBucket = CandidateRule["bucket"];

export const maximumCandidateAgeMs = Math.max(...candidateRules.map((rule) => rule.maximumAgeMs));

export function candidateBuckets(candidate: { createdAt: Date; stars: number }, at: Date): CandidateBucket[] {
  const created = candidate.createdAt.getTime();
  const now = at.getTime();
  if (!Number.isFinite(created) || !Number.isFinite(now) || !Number.isSafeInteger(candidate.stars) ||
      candidate.stars < 0 || created > now) {
    throw new Error("invalid_candidate");
  }
  const age = now - created;
  return candidateRules
    .filter((rule) => age <= rule.maximumAgeMs && candidate.stars >= rule.minimumStars)
    .map((rule) => rule.bucket);
}
