import { describe, expect, it } from "vitest";
import type { GitHubRepository, GitHubSource, SearchSlice } from "../../../../src/sources/github/github-source.js";
import { candidateBuckets, searchCompletely, splitSearchSlice } from "../../../../src/sources/github/repository-search.js";

function repo(id: number, stars = 10): GitHubRepository {
  return {
    githubRepoId: id, nodeId: `R_${id}`, ownerId: id, ownerLogin: "owner", ownerType: "User",
    ownerProfileUrl: "https://github.com/owner", ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
    name: `repo-${id}`, fullName: `owner/repo-${id}`, description: "description",
    repoUrl: `https://github.com/owner/repo-${id}`, homepageUrl: null, defaultBranch: "main",
    language: null, license: null, topics: [], hasReadme: true,
    createdAt: new Date("2026-07-01T12:00:00Z"), pushedAt: new Date("2026-07-19T00:00:00Z"),
    stars, forks: 0, visibility: "public", isPrivate: false, isFork: false, isArchived: false,
    isTemplate: false, isMirror: false,
  };
}

describe("candidateBuckets", () => {
  const at = new Date("2026-07-19T00:00:00Z");

  it("assigns every candidate-v2 bucket including exact boundaries", () => {
    expect(candidateBuckets({ createdAt: new Date("2026-07-18T00:00:00Z"), stars: 100 }, at))
      .toEqual(["age_1d_stars_10", "age_3d_stars_100"]);
    expect(candidateBuckets({ createdAt: new Date("2026-07-16T00:00:00Z"), stars: 100 }, at))
      .toEqual(["age_3d_stars_100"]);
  });

  it("excludes candidate-v2 buckets one millisecond after their age boundaries", () => {
    expect(candidateBuckets({ createdAt: new Date("2026-07-17T23:59:59.999Z"), stars: 99 }, at)).toEqual([]);
    expect(candidateBuckets({ createdAt: new Date("2026-07-15T23:59:59.999Z"), stars: 100_000 }, at)).toEqual([]);
  });

  it("rejects future, invalid, negative-star, and older repositories", () => {
    expect(() => candidateBuckets({ createdAt: new Date("invalid"), stars: 10 }, at)).toThrow(/invalid_candidate/);
    expect(() => candidateBuckets({ createdAt: new Date("2026-07-20T00:00:00Z"), stars: 10 }, at)).toThrow(/invalid_candidate/);
    expect(() => candidateBuckets({ createdAt: at, stars: -1 }, at)).toThrow(/invalid_candidate/);
    expect(candidateBuckets({ createdAt: new Date("2026-06-18T23:59:59Z"), stars: 99_999 }, at)).toEqual([]);
  });
});

describe("search slicing", () => {
  it("splits UTC-second time ranges without a gap or overlap", () => {
    const [left, right] = splitSearchSlice({
      from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-02T00:00:00Z"), minStars: 10,
    });
    expect(left.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(left.to.getTime() + 1_000).toBe(right.from.getTime());
    expect(right.to.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });

  it("splits a single second by non-overlapping star ranges", () => {
    expect(splitSearchSlice({
      from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z"),
      minStars: 10, maxStars: 15,
    })).toEqual([
      { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z"), minStars: 10, maxStars: 12 },
      { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z"), minStars: 13, maxStars: 15 },
    ]);
  });

  it("splits safe-integer star ranges without midpoint overflow", () => {
    const at = new Date("2026-07-01T00:00:00Z");
    const [left, right] = splitSearchSlice({ from: at, to: at, minStars: Number.MAX_SAFE_INTEGER - 3, maxStars: Number.MAX_SAFE_INTEGER });
    expect(left.maxStars! + 1).toBe(right.minStars);
    expect(right.maxStars).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("fails closed when an exact second and star value remains over 1000", async () => {
    const source = sourceFrom(async () => ({ totalCount: 1001, repositories: [repo(1, 10)], hasNextPage: false, nextPage: null }));
    await expect(searchCompletely(source, {
      from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z"), minStars: 10,
    })).rejects.toThrow(/search_partition_exhausted/);
  });

  it("accepts exactly 1000 and follows validated nextPage metadata", async () => {
    const pages: number[] = [];
    const source = sourceFrom(async (_slice, page) => {
      pages.push(page);
      return {
        totalCount: 1000,
        repositories: Array.from({ length: 100 }, (_, index) => repo((page - 1) * 100 + index + 1)),
        hasNextPage: page < 10,
        nextPage: page < 10 ? page + 1 : null,
      };
    });
    expect(await searchCompletely(source, daySlice())).toHaveLength(1000);
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("rejects empty pages that contradict pagination and conflicting duplicate ids", async () => {
    const empty = sourceFrom(async () => ({ totalCount: 2, repositories: [], hasNextPage: true, nextPage: 2 }));
    await expect(searchCompletely(empty, daySlice())).rejects.toThrow(/pagination_contradiction/);

    const conflict = sourceFrom(async (_slice, page) => page === 1
      ? { totalCount: 2, repositories: [repo(1, 10)], hasNextPage: true, nextPage: 2 }
      : { totalCount: 2, repositories: [repo(1, 11)], hasNextPage: false, nextPage: null });
    await expect(searchCompletely(conflict, daySlice())).rejects.toThrow(/pagination_contradiction/);
  });

  it.each([[150, 250], [250, 150]])("rejects total drift from %i to %i", async (firstTotal, secondTotal) => {
    const source = sourceFrom(async (_slice, page) => page === 1
      ? { totalCount: firstTotal, repositories: [repo(1)], rawItemCount: 100, hasNextPage: true, nextPage: 2 }
      : { totalCount: secondTotal, repositories: [repo(2)], rawItemCount: 50, hasNextPage: false, nextPage: null });
    await expect(searchCompletely(source, daySlice())).rejects.toThrow(/pagination_contradiction/);
  });

  it("rejects oversupply and page ten that still advertises next", async () => {
    const oversupply = sourceFrom(async () => ({ totalCount: 1, repositories: [repo(1)], rawItemCount: 2, hasNextPage: false, nextPage: null }));
    await expect(searchCompletely(oversupply, daySlice())).rejects.toThrow(/pagination_contradiction/);
    const endless = sourceFrom(async (_slice, page) => ({
      totalCount: 1_000,
      repositories: Array.from({ length: 100 }, (_, index) => repo((page - 1) * 100 + index + 1)),
      rawItemCount: 100, hasNextPage: true, nextPage: page + 1,
    }));
    await expect(searchCompletely(endless, daySlice())).rejects.toThrow(/pagination_contradiction/);
  });

  it("discards partial pages and reslices when a later page reports over 1000", async () => {
    let initialCalls = 0;
    const initial = daySlice();
    const source = sourceFrom(async (slice, page) => {
      if (slice.from.getTime() === initial.from.getTime() && slice.to.getTime() === initial.to.getTime()) {
        initialCalls += 1;
        return page === 1
          ? { totalCount: 500, repositories: [repo(1)], rawItemCount: 100, hasNextPage: true, nextPage: 2 }
          : { totalCount: 1_001, repositories: [], rawItemCount: 0, hasNextPage: false, nextPage: null };
      }
      return { totalCount: 0, repositories: [], rawItemCount: 0, hasNextPage: false, nextPage: null };
    });
    expect(await searchCompletely(source, initial)).toEqual([]);
    expect(initialCalls).toBe(2);
  });
});

function daySlice(): SearchSlice {
  return { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T23:59:59Z"), minStars: 10 };
}

function sourceFrom(searchRepositories: GitHubSource["searchRepositories"]): GitHubSource {
  return {
    getRateLimit: async () => ({ remaining: 30, resetAt: new Date("2026-07-20T00:00:00Z") }),
    searchRepositories,
    getRepository: async () => repo(1),
    hasReadme: async () => true,
  };
}
