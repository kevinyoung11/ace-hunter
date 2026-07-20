import { beforeEach, describe, expect, it, vi } from "vitest";

const { trending } = vi.hoisted(() => ({ trending: vi.fn() }));

vi.mock("../../../lib/web/service", () => ({ webService: () => ({ trending }) }));

import { GET } from "../../../app/api/trending/route.js";

describe("GET /api/trending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trending.mockResolvedValue({ kind: "trending", period: "daily", items: [] });
  });

  it("defaults the period to daily", async () => {
    const response = await GET(new Request("http://localhost/api/trending"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: "trending", period: "daily", items: [] });
    expect(trending).toHaveBeenCalledWith("daily");
  });

  it("rejects unsupported periods before querying the service", async () => {
    const response = await GET(new Request("http://localhost/api/trending?period=yearly"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "invalid_period" });
    expect(trending).not.toHaveBeenCalled();
  });

  it("returns 404 when the requested trending batch is unavailable", async () => {
    trending.mockResolvedValue({ kind: "not_found", reason: "trending_unavailable", period: "weekly" });

    const response = await GET(new Request("http://localhost/api/trending?period=weekly"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ kind: "not_found", reason: "trending_unavailable", period: "weekly" });
  });

  it("returns a command failure when the service throws", async () => {
    trending.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(new Request("http://localhost/api/trending?period=monthly"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ code: "command_failed" });
  });
});
