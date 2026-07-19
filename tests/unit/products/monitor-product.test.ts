import { describe, expect, it, vi } from "vitest";
import { setProductMonitor } from "../../../src/products/monitor-product.js";

describe("setProductMonitor", () => {
  it.each([[true, "active"], [false, "inactive"]] as const)("upserts only monitor state for active=%s", async (active, status) => {
    const upsert = vi.fn(async () => "monitor-id");
    expect(await setProductMonitor({ upsert }, { userId: "u", productId: "p", active })).toEqual({ monitorId: "monitor-id", status });
    expect(upsert).toHaveBeenCalledWith({ userId: "u", productId: "p", status });
  });

  it("validates identifiers and has no priority input", async () => {
    const upsert = vi.fn(async () => "id");
    await expect(setProductMonitor({ upsert }, { userId: " ", productId: "p", active: true })).rejects.toThrow("invalid_monitor_input");
    expect(upsert).not.toHaveBeenCalled();
  });
});
