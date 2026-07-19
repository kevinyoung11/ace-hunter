import { describe, expect, it } from "vitest";
import { ModelContentAnalyzer } from "../../../src/analysis/model-content-analyzer.js";

const live = process.env.RUN_LIVE_MODEL_CONTRACT === "1" ? describe : describe.skip;

live("live content model contract", () => {
  it("returns one strict versioned classification from the configured DeepSeek model", async () => {
    const apiKey = process.env.ACE_HUNTER_DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("ACE_HUNTER_DEEPSEEK_API_KEY is required");
    const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    const analyzer = new ModelContentAnalyzer({ apiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", model, timeoutMs: 60_000 });
    const result = await analyzer.analyze([{ id: "live-contract-1",
      text: "This open-source repository looks useful. Does it support local deployment?",
      authorUsername: "contract_user" }]);
    expect(result).toEqual([expect.objectContaining({ postId: "live-contract-1", analysisVersion: "x-v1", modelName: model })]);
    expect(result[0].relevanceScore).toBeGreaterThanOrEqual(0);
    expect(result[0].relevanceScore).toBeLessThanOrEqual(1);
  }, 90_000);
});
