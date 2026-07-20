import { describe, expect, it } from "vitest";
import {
  loadPotentialRepositories,
  renderPotentialList,
  type PotentialList,
} from "../../../src/reports/potential-list.js";
import type { Pool } from "pg";

const populated: PotentialList = {
  kind: "potential_repositories",
  rule: "all",
  generatedAt: "2026-07-20T00:00:00.000Z",
  items: [
    {
      repositoryId: "repo-1",
      name: "rocket",
      fullName: "acme/rocket",
      description: "A fast repository",
      owner: "acme",
      repositoryUrl: "https://github.com/acme/rocket",
      homepageUrl: "https://rocket.example/",
      createdAt: "2026-07-19T12:00:00.000Z",
      ageHours: 12,
      stars: 120,
      starsPerHour: 10,
      forks: 7,
      capturedAt: "2026-07-19T23:55:00.000Z",
      matchedRules: ["1d", "3d"],
    },
  ],
};

describe("potential repository Markdown", () => {
  it("shows the selected rule, source links, matching rules and capture time", () => {
    const markdown = renderPotentialList(populated);

    expect(markdown).toContain("筛选规则：全部（1 天 / 3 天）");
    expect(markdown).toContain("命中规则：1 天（24 小时内且 Star ≥ 10）、3 天（72 小时内且 Star ≥ 100）");
    expect(markdown).toContain("GitHub：https://github.com/acme/rocket");
    expect(markdown).toContain("演示网页：https://rocket.example/");
    expect(markdown).toContain("数据捕获时间：2026-07-19T23:55:00.000Z");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });

  it("renders an explicit successful empty state and exactly one trailing newline", () => {
    const markdown = renderPotentialList({ ...populated, rule: "3d", items: [] });

    expect(markdown).toContain("筛选规则：3 天（72 小时内且 Star ≥ 100）");
    expect(markdown).toContain("当前没有符合条件的潜力仓库。");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("potential repository query boundary", () => {
  it("rejects a negative count even if corrupt storage bypasses database constraints", async () => {
    const pool = {
      query: async () => ({
        rows: [{
          repository_id: "repo-1",
          name: "bad",
          full_name: "owner/bad",
          description: null,
          owner_login: "owner",
          repo_url: "https://github.com/owner/bad",
          homepage_url: null,
          github_created_at: new Date("2026-07-19T23:00:00.000Z"),
          captured_at: new Date("2026-07-19T23:30:00.000Z"),
          stars: "-1",
          forks: "0",
        }],
      }),
    } as unknown as Pool;

    await expect(loadPotentialRepositories(pool, {
      now: new Date("2026-07-20T00:00:00.000Z"),
      rule: "all",
      limit: null,
    })).rejects.toThrow("unsafe_potential_numeric_value:stars");
  });
});
