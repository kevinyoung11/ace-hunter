import { expect, it } from "vitest";
import { RequestBudget } from "../../../../src/sources/github/request-budget.js";
import { GitHubSourceError } from "../../../../src/sources/github/github-source.js";

it("bounds cumulative rate-limit sleep rather than each sleep independently", () => {
  const budget = new RequestBudget(10, 60_000);
  budget.allowWait(40_000);
  expect(() => budget.allowWait(40_000)).toThrow(GitHubSourceError);
  expect(() => budget.allowWait(40_000)).toThrow(/rate_limit_budget_exceeded/);
  const requests = new RequestBudget(1, 0);
  requests.consumeRequest();
  expect(() => requests.consumeRequest()).toThrow(GitHubSourceError);
  expect(() => requests.consumeRequest()).toThrow(/request_budget_exceeded/);
});
