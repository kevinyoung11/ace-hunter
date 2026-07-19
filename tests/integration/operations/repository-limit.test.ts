import { describe, expect, it } from "vitest";
import { repositoryCapacityStatus } from "../../../src/jobs/retention.js";

describe("repository capacity policy", () => {
  it.each([
    [0, "ok"],
    [799, "ok"],
    [800, "warning"],
    [949, "warning"],
    [950, "review_required"],
    [999, "review_required"],
  ] as const)("maps %i repositories to %s", (count, expected) => {
    expect(repositoryCapacityStatus(count)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid count %s", (count) => {
    expect(() => repositoryCapacityStatus(count)).toThrow(/invalid_repository_count/);
  });
});
