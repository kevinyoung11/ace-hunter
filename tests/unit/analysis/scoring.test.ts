import { describe, expect, it } from "vitest";

import { cumeDist } from "../../../src/analysis/percentiles.js";
import {
  rankCandidates,
  type ScoreInput,
} from "../../../src/analysis/scoring.js";

function candidate(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    productId: "product-a",
    stars: 100,
    stars24hAgo: 80,
    repoAgeHours: 48,
    xStatus: "success_with_results",
    xPosts: 1,
    xAuthors: 1,
    xEngagement: 1,
    trending: [],
    ...overrides,
  };
}

describe("cumeDist", () => {
  it("gives tied values the same cumulative percentile", () => {
    expect(cumeDist([10, 20, 20, 40])).toEqual([25, 75, 75, 100]);
  });

  it("returns 100 for a single value and an empty result for an empty pool", () => {
    expect(cumeDist([7])).toEqual([100]);
    expect(cumeDist([])).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite values (%s)",
    (value) => {
      expect(() => cumeDist([value])).toThrow(/finite/i);
    },
  );
});

describe("rankCandidates", () => {
  it("computes the approved weighted score with tied growth rates", () => {
    const result = rankCandidates(
      [
        candidate({
          productId: "a",
          stars: 120,
          stars24hAgo: 100,
          xPosts: 2,
          xAuthors: 2,
          xEngagement: 20,
        }),
        candidate({
          productId: "b",
          stars: 240,
          stars24hAgo: 200,
          xPosts: 1,
          xAuthors: 1,
          xEngagement: 10,
          trending: ["weekly"],
        }),
      ],
      "success",
    );

    expect(
      result.map((item) => [
        item.productId,
        item.githubMomentum,
        item.xAttention,
        item.trendingSignal,
        item.attentionScore,
      ]),
    ).toEqual([
      ["b", 100, 50, 70, 87],
      ["a", 70, 100, 0, 69],
    ]);
  });

  it("uses a cold-start proxy for percentiles but exposes unavailable 24-hour facts as null", () => {
    const result = rankCandidates(
      [
        candidate({
          productId: "slow",
          stars: 60,
          stars24hAgo: null,
          repoAgeHours: 60,
          xStatus: "success_empty",
          xPosts: 0,
          xAuthors: 0,
          xEngagement: 0,
        }),
        candidate({
          productId: "fast",
          stars: 12,
          stars24hAgo: null,
          repoAgeHours: 6,
          xStatus: "success_empty",
          xPosts: 0,
          xAuthors: 0,
          xEngagement: 0,
        }),
      ],
      "success",
    );

    expect(result.map((item) => item.productId)).toEqual(["fast", "slow"]);
    expect(result[0]).toMatchObject({
      deltaStars24h: null,
      growthRate24h: null,
      githubMomentum: 100,
    });
    expect(result[1]).toMatchObject({
      deltaStars24h: null,
      growthRate24h: null,
      githubMomentum: 50,
    });
  });

  it("distinguishes an empty successful X query from a source-wide failure", () => {
    const empty = rankCandidates(
      [
        candidate({
          stars: 10,
          stars24hAgo: null,
          repoAgeHours: 6,
          xStatus: "success_empty",
          xPosts: 0,
          xAuthors: 0,
          xEngagement: 0,
        }),
      ],
      "success",
    )[0];
    const unavailable = rankCandidates(
      [
        candidate({
          stars: 10,
          stars24hAgo: null,
          repoAgeHours: 6,
          xStatus: "unavailable",
          xPosts: 0,
          xAuthors: 0,
          xEngagement: 0,
          trending: ["daily"],
        }),
      ],
      "unavailable",
    )[0];

    expect(empty.xAttention).toBe(0);
    expect(empty.attentionScore).toBe(70);
    expect(unavailable.xAttention).toBeNull();
    expect(unavailable.attentionScore).toBe(100);
  });

  it("uses only successful products for X percentiles during a partial run", () => {
    const ranked = rankCandidates(
      [
        candidate({
          productId: "low",
          xPosts: 1,
          xAuthors: 1,
          xEngagement: 1,
        }),
        candidate({
          productId: "high",
          xPosts: 2,
          xAuthors: 2,
          xEngagement: 2,
        }),
        candidate({
          productId: "failed",
          xStatus: "unavailable",
          xPosts: 999,
          xAuthors: 999,
          xEngagement: 999,
        }),
      ],
      "partial",
    );

    expect(ranked.find((item) => item.productId === "high")?.xAttention).toBe(100);
    expect(ranked.find((item) => item.productId === "low")?.xAttention).toBe(50);
    expect(ranked.find((item) => item.productId === "failed")?.xAttention).toBeNull();
    expect(ranked.find((item) => item.productId === "failed")?.attentionScore).toBe(70);
  });

  it("takes the strongest trending period and leaves the caller input unchanged", () => {
    const input = [
      candidate({
        productId: "trend",
        trending: ["monthly", "weekly", "daily"],
      }),
    ];
    const before = structuredClone(input);

    const result = rankCandidates(input, "success");

    expect(result[0].trendingSignal).toBe(100);
    expect(input).toEqual(before);
  });

  it("sorts ties by stars descending and then product id ascending", () => {
    const ranked = rankCandidates(
      [
        candidate({ productId: "z", stars: 30, stars24hAgo: 10 }),
        candidate({ productId: "b", stars: 40, stars24hAgo: 20 }),
        candidate({ productId: "a", stars: 40, stars24hAgo: 20 }),
      ],
      "success",
    );

    expect(ranked.map((item) => item.productId)).toEqual(["a", "b", "z"]);
  });

  it("allows a real negative star delta while rejecting invalid raw metrics", () => {
    const declining = rankCandidates(
      [candidate({ stars: 90, stars24hAgo: 100 })],
      "success",
    )[0];
    expect(declining.deltaStars24h).toBe(-10);
    expect(declining.growthRate24h).toBe(-0.1);

    const invalidInputs: ScoreInput[] = [
      candidate({ stars: -1 }),
      candidate({ stars: Number.NaN }),
      candidate({ stars24hAgo: -1 }),
      candidate({ repoAgeHours: -1 }),
      candidate({ xPosts: -1 }),
      candidate({ xAuthors: Number.POSITIVE_INFINITY }),
      candidate({ xEngagement: Number.NaN }),
      candidate({ xEngagement: Number.MAX_SAFE_INTEGER + 1 }),
      candidate({ productId: "" }),
    ];
    for (const invalid of invalidInputs) {
      expect(() => rankCandidates([invalid], "success")).toThrow();
    }
  });

  it("rejects duplicate product ids", () => {
    expect(() =>
      rankCandidates([candidate(), candidate()], "success"),
    ).toThrow(/duplicate/i);
  });

  it("validates successful X status semantics without inspecting unavailable history", () => {
    expect(() =>
      rankCandidates(
        [candidate({ xStatus: "success_empty", xPosts: 1 })],
        "success",
      ),
    ).toThrow(/success_empty/);
    expect(() =>
      rankCandidates(
        [candidate({ xStatus: "success_with_results", xPosts: 1, xAuthors: 2 })],
        "success",
      ),
    ).toThrow(/authors/i);
    const noRelevantPosts = candidate({
      xStatus: "success_with_results",
      xPosts: 0,
      xAuthors: 0,
      xEngagement: 0,
    });
    expect(rankCandidates([noRelevantPosts], "success")[0].xAttention).toBe(0);

    expect(() =>
      rankCandidates(
        [
          candidate({
            xStatus: "unavailable",
            xPosts: 1,
            xAuthors: 2,
            xEngagement: 500,
          }),
        ],
        "partial",
      ),
    ).not.toThrow();
  });
});
