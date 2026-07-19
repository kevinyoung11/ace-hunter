import { describe, expect, it, vi } from "vitest";
import { resolveProduct, type ResolverStore } from "../../../src/products/resolve-product.js";

function store(rows: { full?: ResolverStore["byGithubFullName"]; name?: ResolverStore["byName"] } = {}): ResolverStore {
  return {
    byGithubFullName: rows.full ?? (async () => []),
    byName: rows.name ?? (async () => []),
  };
}

describe("resolveProduct", () => {
  it.each([
    ["owner/repo", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["http://github.com/owner/repo/", "owner/repo"],
    ["https://github.com/owner/repo.git", "owner/repo"],
  ])("resolves the exact GitHub identity %s", async (input, fullName) => {
    const byGithubFullName = vi.fn(async () => [{ id: "p", name: "Repo" }]);
    expect(await resolveProduct(store({ full: byGithubFullName }), input)).toEqual({ kind: "found", productId: "p" });
    expect(byGithubFullName).toHaveBeenCalledWith(fullName);
  });

  it("returns candidates instead of guessing an ambiguous name", async () => {
    const value = await resolveProduct(store({ name: async () => [{ id: "a", name: "Open" }, { id: "b", name: "Open" }] }), "Open");
    expect(value).toEqual({ kind: "ambiguous", candidates: [{ id: "a", name: "Open" }, { id: "b", name: "Open" }] });
  });

  it("creates only an unseen explicit GitHub URL through the injected boundary", async () => {
    const createFromGithub = vi.fn(async () => ({ productId: "new" }));
    expect(await resolveProduct(store(), "https://github.com/new/repo", { createFromGithub })).toEqual({ kind: "found", productId: "new", created: true });
    expect(await resolveProduct(store(), "new/repo", { createFromGithub })).toEqual({ kind: "not_found" });
    expect(await resolveProduct(store(), "unknown", { createFromGithub })).toEqual({ kind: "not_found" });
    expect(createFromGithub).toHaveBeenCalledTimes(1);
  });

  it.each(["", "https://evil.example/owner/repo", "https://github.com/owner/repo/issues", "owner /repo", "https://github.com/owner/repo?tab=x"])("does not guess malformed input %j", async (input) => {
    const value = await resolveProduct(store(), input);
    expect(value).toEqual({ kind: "not_found" });
  });
});
