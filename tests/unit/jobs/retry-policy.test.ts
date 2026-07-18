import { describe, expect, it } from "vitest";
import {
  canonicalJobParameters,
  jobIdempotencyKey,
  retryDelayMs,
} from "../../../src/jobs/retry-policy.js";

describe("retry policy", () => {
  it("uses exactly two approved retry delays", () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([300_000, 1_200_000, null]);
  });

  it("canonicalizes object keys recursively while preserving arrays", () => {
    expect(canonicalJobParameters({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
    expect(
      jobIdempotencyKey("job", new Date("2026-07-19T00:00:00Z"), { b: 2, a: 1 }),
    ).toMatch(/^job:2026-07-19T00:00:00\.000Z:[a-f0-9]{64}$/);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => 1 }],
    ["symbol", { value: Symbol("x") }],
    ["bigint", { value: 1n }],
    ["nonfinite", { value: Number.NaN }],
    ["custom prototype", Object.create({ inherited: true })],
    ["invalid date", { value: new Date("invalid") }],
  ])("rejects non-JSON input: %s", (_label, value) => {
    expect(() => canonicalJobParameters(value as Record<string, unknown>)).toThrow();
  });

  it("rejects cycles and bounded-resource violations", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJobParameters(cyclic)).toThrow(/cyclic/i);
    expect(() => canonicalJobParameters({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toThrow();
    expect(() => canonicalJobParameters({ a: 1, b: 2 }, { maxKeys: 1 })).toThrow();
    expect(() => canonicalJobParameters({ a: "123" }, { maxBytes: 3 })).toThrow();
  });
});
