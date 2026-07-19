import { expect, it } from "vitest";

import { representativePosts } from "../../../src/analysis/representative-posts.js";

it("selects category-diverse representative evidence deterministically without mutating posts", () => {
  const posts = [
    { id: "launch", category: "project_launch", engagement: 999, createdAt: new Date("2026-07-19T03:00:00Z") },
    { id: "analysis-old", category: "independent_analysis", engagement: 10, createdAt: new Date("2026-07-19T01:00:00Z") },
    { id: "usage", category: "real_usage", engagement: 1, createdAt: new Date("2026-07-19T00:00:00Z") },
    { id: "analysis-new", category: "independent_analysis", engagement: 10, createdAt: new Date("2026-07-19T02:00:00Z") },
  ] as const;
  const before = posts.map((post) => post.id);

  expect(representativePosts(posts).map((post) => post.id)).toEqual(["usage", "analysis-new"]);
  expect(posts.map((post) => post.id)).toEqual(before);
});

it("uses engagement, recency, then stable id/url tie-breakers inside a category", () => {
  const at = new Date("2026-07-19T00:00:00Z");
  const posts = [
    { id: "b", url: "https://x.com/b", category: "real_usage", engagement: 2, createdAt: at },
    { id: "a", url: "https://x.com/a", category: "real_usage", engagement: 2, createdAt: at },
  ];
  expect(representativePosts(posts).map((post) => post.id)).toEqual(["a", "b"]);
});
