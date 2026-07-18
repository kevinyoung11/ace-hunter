import { expect, it } from "vitest";
import { RequestBudget } from "../../../../src/sources/github/request-budget.js";

it("bounds cumulative rate-limit sleep rather than each sleep independently", () => {
  const budget = new RequestBudget(10, 60_000);
  budget.allowWait(40_000);
  expect(() => budget.allowWait(40_000)).toThrow(/github_rate_limit_budget_exceeded/);
});
