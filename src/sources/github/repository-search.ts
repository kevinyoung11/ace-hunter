import { GitHubSourceError, type GitHubRepository, type GitHubSource, type SearchSlice } from "./github-source.js";

const secondMs = 1_000;
const dayMs = 86_400_000;
const maxSlices = 20_000;

export function candidateBuckets(repo: { createdAt: Date; stars: number }, at: Date): string[] {
  const created = repo.createdAt.getTime();
  const now = at.getTime();
  if (!Number.isFinite(created) || !Number.isFinite(now) || !Number.isSafeInteger(repo.stars) || repo.stars < 0 || created > now) {
    throw new Error("invalid_candidate");
  }
  const age = now - created;
  return [
    age <= dayMs && repo.stars >= 10 ? "age_1d_stars_10" : null,
    age <= 7 * dayMs && repo.stars >= 100 ? "age_7d_stars_100" : null,
    age <= 30 * dayMs && repo.stars >= 1_000 ? "age_30d_stars_1000" : null,
  ].filter((value): value is string => value !== null);
}

export function splitSearchSlice(slice: SearchSlice): [SearchSlice, SearchSlice] {
  validateSlice(slice);
  const fromSecond = slice.from.getTime() / secondMs;
  const toSecond = slice.to.getTime() / secondMs;
  if (fromSecond < toSecond) {
    const middleSecond = fromSecond + Math.floor((toSecond - fromSecond) / 2);
    return [
      { ...slice, to: new Date(middleSecond * secondMs) },
      { ...slice, from: new Date((middleSecond + 1) * secondMs) },
    ];
  }
  if (slice.maxStars === undefined || slice.maxStars <= slice.minStars) {
    throw new GitHubSourceError("search_partition_exhausted");
  }
  const starMiddle = slice.minStars + Math.floor((slice.maxStars - slice.minStars) / 2);
  return [
    { ...slice, maxStars: starMiddle },
    { ...slice, minStars: starMiddle + 1 },
  ];
}

export async function searchCompletely(source: GitHubSource, initial: SearchSlice): Promise<GitHubRepository[]> {
  validateSlice(initial);
  const pending: SearchSlice[] = [initial];
  const repositories = new Map<number, GitHubRepository>();
  let processedSlices = 0;
  while (pending.length > 0) {
    if (++processedSlices > maxSlices) throw new Error("github_search_slice_budget_exceeded");
    let slice = pending.pop()!;
    const first = await source.searchRepositories(slice, 1);
    validatePage(first, 1);
    if (first.totalCount > 1_000) {
      if (sameSecond(slice) && slice.maxStars === undefined) {
        const maximum = first.repositories[0]?.stars;
        if (maximum === undefined || maximum < slice.minStars) throw new Error("github_search_pagination_contradiction");
        slice = { ...slice, maxStars: maximum };
      }
      const [left, right] = splitSearchSlice(slice);
      pending.push(right, left);
      continue;
    }
    let page = first;
    let pageNumber = 1;
    let pageCount = 0;
    const sliceRepositories: GitHubRepository[] = [];
    const sliceIds = new Set<number>();
    let rawItemsSeen = 0;
    let mustReslice = false;
    while (true) {
      pageCount += 1;
      if (pageCount > 10) throw new Error("github_search_page_budget_exceeded");
      if (page.totalCount > 1_000) { mustReslice = true; break; }
      if (page.totalCount !== first.totalCount) throw new Error("github_search_pagination_contradiction");
      if (page.repositories.length === 0 && (page.hasNextPage || first.totalCount > 0 && pageNumber === 1)) {
        throw new Error("github_search_pagination_contradiction");
      }
      for (const repository of page.repositories) validateRepositoryInSlice(repository, slice);
      for (const repository of page.repositories) {
        if (sliceIds.has(repository.githubRepoId)) throw new Error("github_search_pagination_contradiction");
        sliceIds.add(repository.githubRepoId);
      }
      sliceRepositories.push(...page.repositories);
      rawItemsSeen += page.rawItemCount ?? page.repositories.length;
      if (!page.hasNextPage) break;
      if (pageNumber === 10) throw new Error("github_search_pagination_contradiction");
      if (page.nextPage !== pageNumber + 1) throw new Error("github_search_pagination_contradiction");
      pageNumber = page.nextPage;
      page = await source.searchRepositories(slice, pageNumber);
      validatePage(page, pageNumber);
    }
    if (mustReslice) {
      if (sameSecond(slice) && slice.maxStars === undefined) {
        const maximum = first.repositories[0]?.stars;
        if (maximum === undefined) throw new Error("github_search_pagination_contradiction");
        slice = { ...slice, maxStars: maximum };
      }
      const [left, right] = splitSearchSlice(slice);
      pending.push(right, left);
      continue;
    }
    if (rawItemsSeen !== first.totalCount) throw new Error("github_search_pagination_contradiction");
    for (const repository of sliceRepositories) addRepository(repositories, repository);
  }
  return [...repositories.values()].sort((a, b) => a.githubRepoId - b.githubRepoId);
}

function validateSlice(slice: SearchSlice): void {
  const from = slice.from.getTime();
  const to = slice.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from % secondMs !== 0 || to % secondMs !== 0 || from > to ||
      !Number.isSafeInteger(slice.minStars) || slice.minStars < 0 ||
      slice.maxStars !== undefined && (!Number.isSafeInteger(slice.maxStars) || slice.maxStars < slice.minStars)) {
    throw new Error("invalid_search_slice");
  }
}

function validatePage(page: { totalCount: number; repositories: GitHubRepository[]; rawItemCount?: number; hasNextPage: boolean; nextPage: number | null }, pageNumber: number): void {
  if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || !Number.isInteger(pageNumber) || pageNumber < 1 ||
      page.rawItemCount !== undefined && (!Number.isSafeInteger(page.rawItemCount) || page.rawItemCount < page.repositories.length || page.rawItemCount > 100) ||
      page.hasNextPage !== (page.nextPage !== null) || page.nextPage !== null && (!Number.isInteger(page.nextPage) || page.nextPage <= pageNumber)) {
    throw new Error("github_search_pagination_contradiction");
  }
}

function sameSecond(slice: SearchSlice): boolean {
  return slice.from.getTime() === slice.to.getTime();
}

function validateRepositoryInSlice(repository: GitHubRepository, slice: SearchSlice): void {
  if (!Number.isSafeInteger(repository.githubRepoId) || repository.githubRepoId <= 0 || repository.createdAt < slice.from || repository.createdAt > slice.to ||
      repository.stars < slice.minStars || slice.maxStars !== undefined && repository.stars > slice.maxStars) {
    throw new Error("github_search_repository_outside_slice");
  }
  if (repository.isPrivate || repository.visibility !== "public") throw new Error("private_repository");
}

function addRepository(byId: Map<number, GitHubRepository>, repository: GitHubRepository): void {
  const existing = byId.get(repository.githubRepoId);
  if (existing && repositoryFingerprint(existing) !== repositoryFingerprint(repository)) {
    throw new Error("github_repository_identity_conflict");
  }
  byId.set(repository.githubRepoId, repository);
}

function repositoryFingerprint(repository: GitHubRepository): string {
  return JSON.stringify({ ...repository, createdAt: repository.createdAt.toISOString(), pushedAt: repository.pushedAt?.toISOString() ?? null });
}
