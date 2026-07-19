import { expect, it, vi } from "vitest";
import { analyzeProduct } from "../../../src/products/analyze-product.js";

it("persists an immutable offline product_analysis from latest facts", async () => {
  const facts = { item: { productId: "p", score: 81 }, completedSources: ["github"], missingSources: ["x"] };
  const persistAnalysis = vi.fn(async () => "analysis-id");
  const result = await analyzeProduct({ loadLatestFacts: async () => facts, persistAnalysis }, "p", { now: new Date("2026-07-19T08:00:00Z") });
  expect(result).toEqual({ kind: "created", analysisId: "analysis-id", status: "partial" });
  expect(persistAnalysis).toHaveBeenCalledWith(expect.objectContaining({
    outputType: "product_analysis", productId: "p", dataCutoffAt: new Date("2026-07-19T08:00:00Z"),
    status: "partial", facts,
  }));
});

it("does not persist when there are no offline facts", async () => {
  const persistAnalysis = vi.fn();
  expect(await analyzeProduct({ loadLatestFacts: async () => null, persistAnalysis }, "p", { now: new Date() })).toEqual({ kind: "not_found" });
  expect(persistAnalysis).not.toHaveBeenCalled();
});
