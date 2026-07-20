import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createStoredFactsService } from "../../../src/web/stored-facts-service.js";

describe("createStoredFactsService", () => {
  it("preserves ambiguous analysis responses", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }] }) } as unknown as Pool;
    const service = createStoredFactsService({ pool, userId: "11111111-1111-4111-8111-111111111111" });
    const ambiguous = { kind: "ambiguous", candidates: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }] };

    await expect(service.analyze("Alpha")).resolves.toEqual(ambiguous);
  });

  it("returns the latest requested trending batch ordered by rank", async () => {
    const capturedAt = new Date("2026-07-21T08:00:00.000Z");
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [
        { rank: 1, full_name: "acme/alpha", repo_url: "https://github.com/acme/alpha", language: "TypeScript", stars_in_period: "42", stars: "1200", captured_at: capturedAt },
        { rank: 2, full_name: "acme/beta", repo_url: "https://github.com/acme/beta", language: "Python", stars_in_period: null, stars: null, captured_at: capturedAt },
      ] }),
    } as unknown as Pool;
    const service = createStoredFactsService({ pool, userId: "11111111-1111-4111-8111-111111111111" });

    await expect(service.trending("daily")).resolves.toEqual({
      kind: "trending",
      period: "daily",
      items: [
        { rank: 1, fullName: "acme/alpha", repoUrl: "https://github.com/acme/alpha", language: "TypeScript", starsInPeriod: 42, stars: 1200, capturedAt: "2026-07-21T08:00:00.000Z" },
        { rank: 2, fullName: "acme/beta", repoUrl: "https://github.com/acme/beta", language: "Python", starsInPeriod: null, stars: null, capturedAt: "2026-07-21T08:00:00.000Z" },
      ],
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("max(captured_at)"), ["daily"]);
  });

  it("returns a period-specific unavailable response when no trending batch exists", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    const service = createStoredFactsService({ pool, userId: "11111111-1111-4111-8111-111111111111" });

    await expect(service.trending("monthly")).resolves.toEqual({ kind: "not_found", reason: "trending_unavailable", period: "monthly" });
  });
});
