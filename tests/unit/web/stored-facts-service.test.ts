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
});
