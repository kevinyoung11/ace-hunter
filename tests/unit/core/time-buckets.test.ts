import { expect, it } from "vitest";
import { utcDayBucket, utcHourBucket } from "../../../src/core/time-buckets.js";

it("creates stable UTC hour and day buckets", () => {
  const instant = new Date("2026-07-19T23:59:59.999-07:00");
  expect(utcHourBucket(instant).toISOString()).toBe("2026-07-20T06:00:00.000Z");
  expect(utcDayBucket(instant).toISOString()).toBe("2026-07-20T00:00:00.000Z");
});

it("rejects invalid dates", () => {
  expect(() => utcHourBucket(new Date("invalid"))).toThrow();
  expect(() => utcDayBucket(new Date("invalid"))).toThrow();
});

it("does not mutate inputs at exact UTC boundaries", () => {
  const instant = new Date("2026-01-01T00:00:00.000Z");
  const before = instant.getTime();
  expect(utcHourBucket(instant).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(utcDayBucket(instant).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(instant.getTime()).toBe(before);
  expect(utcDayBucket(new Date("2025-12-31T23:59:59.999Z")).toISOString())
    .toBe("2025-12-31T00:00:00.000Z");
});
