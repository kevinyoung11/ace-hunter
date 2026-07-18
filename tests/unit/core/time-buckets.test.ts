import { expect, it } from "vitest";
import { utcDayBucket, utcHourBucket } from "../../../src/core/time-buckets.js";

it("creates stable UTC hour and day buckets", () => {
  const instant = new Date("2026-07-19T23:59:59.999-07:00");
  expect(utcHourBucket(instant).toISOString()).toBe("2026-07-20T06:00:00.000Z");
  expect(utcDayBucket(instant).toISOString()).toBe("2026-07-20T00:00:00.000Z");
});

it("rejects invalid dates", () => {
  expect(() => utcHourBucket(new Date("invalid"))).toThrow();
});
