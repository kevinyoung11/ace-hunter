const categoryPriority: Readonly<Record<string, number>> = Object.freeze({
  real_usage: 0,
  independent_analysis: 1,
  analysis: 1,
  project_launch: 2,
  launch: 2,
  news_repost: 3,
});

export interface RepresentativePostCandidate {
  readonly category: string;
  readonly engagement: number;
  readonly createdAt: Date;
  readonly id?: string;
  readonly url?: string;
}

function stableKey(post: RepresentativePostCandidate): string {
  return post.id ?? post.url ?? "";
}

/** Select at most two posts using the approved evidence-category priority. */
export function representativePosts<T extends RepresentativePostCandidate>(posts: readonly T[]): T[] {
  return [...posts]
    .sort((left, right) =>
      (categoryPriority[left.category] ?? 4) - (categoryPriority[right.category] ?? 4)
      || right.engagement - left.engagement
      || right.createdAt.getTime() - left.createdAt.getTime()
      || stableKey(left).localeCompare(stableKey(right)),
    )
    .slice(0, 2);
}
