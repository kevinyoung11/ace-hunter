import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  loadTrendingLists,
  renderTrendingLists,
  type TrendingLists,
} from "../../../src/reports/trending-list.js";

const populated: TrendingLists = {
  kind: "trending_lists",
  period: "all",
  generatedAt: "2026-07-20T12:00:00.000Z",
  lists: [
    {
      period: "daily", status: "available", capturedAt: "2026-07-20T00:00:00.000Z",
      sourceUrl: "https://github.com/trending?since=daily", stale: false,
      items: [{
        repositoryId: "repo-1", rank: 1, name: "rocket", fullName: "acme/rocket",
        description: "Fast project", owner: "acme", repositoryUrl: "https://github.com/acme/rocket",
        homepageUrl: "https://rocket.example/", stars: 120, starsCapturedAt: "2026-07-20T11:55:00.000Z",
        starsInPeriod: 30,
      }],
    },
    {
      period: "weekly", status: "available", capturedAt: "2026-07-18T00:00:00.000Z",
      sourceUrl: "https://github.com/trending?since=weekly", stale: true, items: [],
    },
    { period: "monthly", status: "unavailable" },
  ],
};

describe("GitHub Trending Markdown", () => {
  it("renders sources, capture facts, stale and unavailable states deterministically", () => {
    const markdown = renderTrendingLists(populated);

    expect(markdown).toContain("# GitHub Trending 日榜 / 周榜 / 月榜");
    expect(markdown).toContain("## 日榜");
    expect(markdown).toContain("榜单捕获时间：2026-07-20T00:00:00.000Z");
    expect(markdown).toContain("[榜单来源](<https://github.com/trending?since=daily>)");
    expect(markdown).toContain("总 Star：120（事实时间：2026-07-20T11:55:00.000Z）");
    expect(markdown).toContain("周期新增 Star：30");
    expect(markdown).toContain("该榜单数据可能已过期（超过 36 小时）。");
    expect(markdown).toContain("月榜当前不可用：没有可验证的完整采集批次。");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
    expect(renderTrendingLists(populated)).toBe(markdown);
  });

  it("keeps untrusted metadata on one escaped line and uses angle-bracket links", () => {
    const original = populated.lists[0];
    if (original.status !== "available") throw new Error("expected available fixture");
    const value: TrendingLists = {
      ...populated,
      lists: [{
        ...original,
        sourceUrl: "https://github.com/trending?since=daily_(all)",
        items: [{
          ...original.items[0],
          fullName: "acme/#rocket*", owner: "owner_*",
          description: "first line\n## injected *bold* [link](x) | cell",
          repositoryUrl: "https://github.com/acme/rocket_(fast)",
          homepageUrl: "https://rocket.example/demo_(one)",
        }],
      }],
    };

    const markdown = renderTrendingLists(value);
    expect(markdown).toContain("### 1. acme/\\#rocket\\*");
    expect(markdown).toContain("简介：first line \\#\\# injected \\*bold\\* \\[link\\]\\(x\\) \\| cell");
    expect(markdown).toContain("作者：owner\\_\\*");
    expect(markdown).toContain("[GitHub](<https://github.com/acme/rocket_(fast)>)");
    expect(markdown).toContain("[演示网页](<https://rocket.example/demo_(one)>)");
    expect(markdown).not.toContain("\n## injected");
  });
});

describe("GitHub Trending query boundary", () => {
  it("rejects invalid options before querying", async () => {
    let queries = 0;
    const pool = { query: async () => { queries += 1; return { rows: [] }; } } as unknown as Pool;

    await expect(loadTrendingLists(pool, { now: new Date("bad"), period: "all", limit: 20 }))
      .rejects.toThrow("invalid_trending_now");
    await expect(loadTrendingLists(pool, { now: new Date(), period: "bad" as "all", limit: 20 }))
      .rejects.toThrow("invalid_trending_period");
    for (const limit of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(loadTrendingLists(pool, { now: new Date(), period: "all", limit }))
        .rejects.toThrow("invalid_trending_limit");
    }
    expect(queries).toBe(0);
  });

  it("rejects unsafe numeric facts returned by storage", async () => {
    const pool = {
      query: async () => ({ rows: [{
        period: "daily", captured_at: new Date("2026-07-20T00:00:00Z"),
        source_url: "https://github.com/trending?since=daily", repository_id: "repo-1",
        rank: 1, stars_in_period: "9007199254740992", name: "bad", full_name: "owner/bad",
        description: null, owner_login: "owner", repo_url: "https://github.com/owner/bad",
        homepage_url: null, stars: null, stars_captured_at: null,
      }] }),
    } as unknown as Pool;

    await expect(loadTrendingLists(pool, {
      now: new Date("2026-07-20T12:00:00Z"), period: "daily", limit: null,
    })).rejects.toThrow("unsafe_trending_numeric_value:starsInPeriod");
  });
});
