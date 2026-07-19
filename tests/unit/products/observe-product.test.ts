import { describe, expect, it, vi } from "vitest";
import { createProcessRegistry, observeProduct, type ObserveDependencies } from "../../../src/products/observe-product.js";

function dependencies(overrides: Partial<ObserveDependencies> = {}): ObserveDependencies {
  return {
    latestFreshness: async () => ({ githubAt: new Date(), xAt: new Date() }),
    refreshGithub: async () => ({ stars: 1 }), collectX: async () => ["post"], analyzeX: async () => ["analysis"],
    killActiveChildren: async () => undefined, persist: async () => "id", enqueueComments: async () => undefined,
    ...overrides,
  };
}

describe("observeProduct", () => {
  it("uses the 5 minute GitHub and 15 minute X freshness boundaries", async () => {
    const refreshGithub = vi.fn(async () => ({})); const collectX = vi.fn(async () => []); const analyzeX = vi.fn(async () => []);
    await observeProduct(dependencies({
      latestFreshness: async () => ({ githubAt: new Date("2026-07-19T00:04:59Z"), xAt: new Date("2026-07-18T23:44:59Z") }),
      refreshGithub, collectX, analyzeX,
    }), "p", { deadlineMs: 100, now: new Date("2026-07-19T00:05:00Z") });
    expect(refreshGithub).not.toHaveBeenCalled(); expect(collectX).toHaveBeenCalledOnce(); expect(analyzeX).toHaveBeenCalledOnce();
  });

  it("collects then analyzes stale X", async () => {
    const order: string[] = [];
    const result = await observeProduct(dependencies({ latestFreshness: async () => ({ githubAt: new Date(), xAt: null }), collectX: async () => { order.push("collect"); return ["post"]; }, analyzeX: async () => { order.push("analyze"); return ["analysis"]; } }), "p", { deadlineMs: 100, now: new Date() });
    expect(order).toEqual(["collect", "analyze"]); expect(result.status).toBe("complete");
  });

  it("returns after the hard deadline even when a source ignores AbortSignal", async () => {
    let killed = false;
    const started = Date.now();
    const result = await observeProduct(dependencies({ latestFreshness: async () => ({ githubAt: null, xAt: null }), collectX: async () => new Promise<never>(() => undefined), killActiveChildren: async () => { killed = true; } }), "p", { deadlineMs: 15, now: new Date() });
    expect(Date.now() - started).toBeLessThan(100); expect(killed).toBe(true);
    expect(result).toMatchObject({ status: "partial", completedSources: ["github"], missingSources: ["x"] });
  });

  it("does not wait for comments and reports independent source failure as partial", async () => {
    let releaseComments!: () => void;
    const comments = new Promise<void>((resolve) => { releaseComments = resolve; });
    const persist = vi.fn(async () => "observation-id");
    const result = await observeProduct(dependencies({ latestFreshness: async () => ({ githubAt: null, xAt: null }), refreshGithub: async () => { throw new Error("github down"); }, enqueueComments: async () => comments, persist }), "p", { deadlineMs: 100, now: new Date() });
    expect(result.status).toBe("partial"); expect(result.missingSources).toEqual(["github"]); expect(result.observationId).toBe("observation-id");
    releaseComments();
  });
});

describe("createProcessRegistry", () => {
  it("waits for close and escalates to SIGKILL after the fallback", async () => {
    const listeners: Array<() => void> = []; const kills: string[] = [];
    const child = { once: (_event: "close", listener: () => void) => { listeners.push(listener); return child; }, kill: (signal?: NodeJS.Signals | number) => { kills.push(String(signal)); if (signal === "SIGKILL") queueMicrotask(() => listeners.splice(0).forEach((fn) => fn())); return true; } };
    const registry = createProcessRegistry({ fallbackMs: 5 }); registry.register(child);
    await registry.killActiveChildren();
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]); expect(registry.size).toBe(0);
  });
});
