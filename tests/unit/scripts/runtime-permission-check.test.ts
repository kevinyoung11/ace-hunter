import { expect, it, vi } from "vitest";
import { verifyRuntimePermissions } from "../../../scripts/runtime-permission-check.js";

it("allows transactional Ace writes and requires every privilege escape to be denied", async () => {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (/^(create schema|create table public|select \* from auth|alter table|set role)/i.test(sql)) {
      throw Object.assign(new Error("permission denied"), { code: "42501" });
    }
    return { rows: [] };
  });
  await verifyRuntimePermissions({ query });
  expect(statements).toContain("rollback");
  expect(statements).toContain("select count(*) from ace_hunter.products");
});

it("fails when a forbidden statement is unexpectedly allowed", async () => {
  await expect(verifyRuntimePermissions({ query: vi.fn(async () => ({ rows: [] })) })).rejects.toThrow("unexpectedly_allowed");
});
